/**
 * The desktop adapter.
 *
 * Every call crosses into Rust, which reads the key from the OS keychain and makes the HTTPS
 * request itself. The key is never returned across this boundary — the most the frontend can
 * learn is whether one is configured and its last four characters.
 *
 * That is why the Tauri capability file grants no network permission at all: the webview never
 * needs to reach api.anthropic.com, so it is never allowed to.
 */

import { invoke } from '@tauri-apps/api/core';
import {
  ClaudeError,
  type ConnectionCheck,
  type ClaudePort,
  type ClaudeReply,
  type ClaudeRequest,
  type KeyStatus,
  type ModelInfo,
} from './ClaudePort.ts';

interface RustKeyStatus {
  readonly configured: boolean;
  readonly source: 'env' | 'keychain' | 'none';
  readonly hint: string | null;
  readonly connection: ConnectionCheck;
}

function toKeyStatus(raw: RustKeyStatus): KeyStatus {
  return {
    configured: raw.configured,
    source: raw.source,
    hint: raw.hint,
    connection: raw.connection,
  };
}

/** Rust returns its errors as strings, already redacted of anything key-shaped. */
async function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(name, args);
  } catch (error) {
    const message = typeof error === 'string' ? error : String(error);
    throw new ClaudeError(message, /rejected|401|invalid/i.test(message) ? 'rejected' : 'network');
  }
}

interface MessagesResponse {
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
  readonly model?: string;
}

export class TauriClaude implements ClaudePort {
  async keyStatus(): Promise<KeyStatus> {
    return toKeyStatus(await command<RustKeyStatus>('claude_key_status'));
  }

  async setKey(key: string): Promise<KeyStatus> {
    return toKeyStatus(await command<RustKeyStatus>('claude_key_set', { key }));
  }

  async clearKey(): Promise<KeyStatus> {
    return toKeyStatus(await command<RustKeyStatus>('claude_key_clear'));
  }

  async verifyConnection(): Promise<KeyStatus> {
    return toKeyStatus(await command<RustKeyStatus>('claude_verify_connection'));
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    const status = await this.keyStatus();
    if (!status.configured) return [];

    const body = await command<{ data?: readonly { id: string; display_name?: string }[] }>(
      'claude_list_models',
    );
    return (body.data ?? []).map((entry) => ({
      id: entry.id,
      ...(entry.display_name === undefined ? {} : { displayName: entry.display_name }),
    }));
  }

  async send(request: ClaudeRequest): Promise<ClaudeReply> {
    const started = performance.now();

    const body = await command<MessagesResponse>('claude_send_message', {
      body: {
        model: request.model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      },
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
