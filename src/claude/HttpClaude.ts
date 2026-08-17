/**
 * The browser-mode adapter.
 *
 * Talks to the Vite middleware in `server/claudeProxy.ts`, never to Anthropic directly. The key
 * is posted to the proxy once and kept in that process's memory, so it is never in the bundle,
 * never in devtools, and never written to disk.
 *
 * This is also why `anthropic-dangerous-direct-browser-access` appears nowhere in this project:
 * the browser never holds a credential, so there is no CORS problem to opt out of.
 */

import {
  ClaudeError,
  type ClaudePort,
  type ClaudeReply,
  type ClaudeRequest,
  type KeyStatus,
  type ModelInfo,
} from './ClaudePort.ts';

const BASE = '/__claude';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, init);
  } catch (error) {
    throw new ClaudeError(
      `Could not reach the local dev proxy. Is \`npm run dev\` still running? (${error instanceof Error ? error.message : String(error)})`,
      'network',
    );
  }

  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new ClaudeError(
      body.error ?? `The proxy returned ${response.status}.`,
      response.status === 400 ? 'rejected' : 'network',
    );
  }
  return body as T;
}

interface MessagesResponse {
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
  readonly model?: string;
}

export class HttpClaude implements ClaudePort {
  keyStatus(): Promise<KeyStatus> {
    return call<KeyStatus>('/key');
  }

  setKey(key: string): Promise<KeyStatus> {
    return call<KeyStatus>('/key', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    });
  }

  clearKey(): Promise<KeyStatus> {
    return call<KeyStatus>('/key', { method: 'DELETE' });
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    const status = await this.keyStatus();
    if (!status.configured) return [];

    const body = await call<{ data?: readonly { id: string; display_name?: string }[] }>('/models');
    return (body.data ?? []).map((entry) => ({
      id: entry.id,
      ...(entry.display_name === undefined ? {} : { displayName: entry.display_name }),
    }));
  }

  async send(request: ClaudeRequest): Promise<ClaudeReply> {
    const started = performance.now();

    const body = await call<MessagesResponse>('/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      }),
    });

    const text = (body.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');

    if (text.trim() === '') {
      throw new ClaudeError('The model returned an empty reply.', 'malformed');
    }

    return {
      text,
      ...(body.model === undefined ? {} : { model: body.model }),
      latencyMs: Math.round(performance.now() - started),
      fromRecording: false,
    };
  }
}
