/**
 * The dev-mode Claude proxy.
 *
 * In the packaged desktop app the Anthropic call is made from Rust, so the key never enters the
 * webview. Browser mode has no Rust, and this middleware is what replaces it: the key is posted
 * here once from the Settings screen and then **stays in this process's memory**.
 *
 * What that buys:
 *
 *   - the key is never written to disk, so it cannot end up committed;
 *   - it is never part of the client bundle, so it is not in view-source or devtools;
 *   - it dies with the dev server, so a shared machine does not inherit it.
 *
 * The browser is told only *whether* a key is set, and the last four characters so a person can
 * tell which key they pasted. The key itself is never sent back.
 *
 * This middleware runs under `vite dev` only. It is not part of a production build, because the
 * production target is the Tauri app.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

const ANTHROPIC_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

/** Where the current key came from. `env` is the automation fallback. */
export type KeySource = 'runtime' | 'env' | 'none';

export interface KeyStatus {
  readonly configured: boolean;
  readonly source: KeySource;
  /** Last four characters, for identification only. Never the whole key. */
  readonly hint: string | null;
}

/**
 * The key, held only here.
 *
 * A module-level binding rather than anything persisted. There is deliberately no code path
 * that writes this value anywhere.
 */
let runtimeKey: string | null = null;

function envKey(): string | null {
  const value = process.env['ANTHROPIC_API_KEY'];
  return value !== undefined && value.trim() !== '' ? value.trim() : null;
}

function activeKey(): { key: string; source: KeySource } | null {
  if (runtimeKey !== null) return { key: runtimeKey, source: 'runtime' };
  const fromEnv = envKey();
  if (fromEnv !== null) return { key: fromEnv, source: 'env' };
  return null;
}

function status(): KeyStatus {
  const active = activeKey();
  if (active === null) return { configured: false, source: 'none', hint: null };
  return { configured: true, source: active.source, hint: active.key.slice(-4) };
}

/**
 * Strips anything key-shaped out of text before it is logged or returned.
 *
 * Upstream error bodies sometimes echo the credential that failed. Redacting by pattern as well
 * as by exact value means a key that was never held here still cannot be leaked onward.
 */
export function redact(text: string, key: string | null): string {
  let output = text;
  if (key !== null && key.length > 0) output = output.split(key).join('[redacted]');
  return output.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]');
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString('utf8');
  if (body.trim() === '') return {};
  return JSON.parse(body) as unknown;
}

function sendJson(response: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.statusCode = code;
  response.setHeader('content-type', 'application/json');
  // The key must never be cached by anything between here and the browser.
  response.setHeader('cache-control', 'no-store');
  response.end(text);
}

/** Verifies a key is real before we accept it, so a typo fails in Settings and not mid-task. */
async function verifyKey(key: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await fetch(`${ANTHROPIC_BASE}/v1/models?limit=1`, {
      headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
    });
    if (response.ok) return { ok: true };
    if (response.status === 401) return { ok: false, message: 'That key was rejected by Anthropic (401). Check it was copied in full.' };
    const detail = redact(await response.text(), key).slice(0, 300);
    return { ok: false, message: `Anthropic returned ${response.status}. ${detail}` };
  } catch (error) {
    const detail = redact(error instanceof Error ? error.message : String(error), key);
    return { ok: false, message: `Could not reach Anthropic: ${detail}` };
  }
}

/** Forwards a request upstream, attaching the key server-side. */
async function forward(
  path: string,
  init: { method: string; body?: string },
): Promise<{ code: number; body: unknown }> {
  const active = activeKey();
  if (active === null) {
    return { code: 400, body: { error: 'No API key configured.' } };
  }

  try {
    const response = await fetch(`${ANTHROPIC_BASE}${path}`, {
      method: init.method,
      headers: {
        'x-api-key': active.key,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      ...(init.body === undefined ? {} : { body: init.body }),
    });

    const text = await response.text();
    const safe = redact(text, active.key);
    if (!response.ok) {
      return { code: response.status, body: { error: safe.slice(0, 1000) } };
    }
    return { code: 200, body: JSON.parse(safe) as unknown };
  } catch (error) {
    const detail = redact(error instanceof Error ? error.message : String(error), active.key);
    return { code: 502, body: { error: `Upstream request failed: ${detail}` } };
  }
}

export function claudeProxy(): Plugin {
  return {
    name: 'claude-proxy',
    configureServer(server) {
      server.middlewares.use('/__claude', (request, response, next) => {
        const url = request.url ?? '/';
        const path = url.split('?')[0] ?? '/';
        const method = request.method ?? 'GET';

        void (async () => {
          try {
            if (path === '/key' && method === 'GET') {
              sendJson(response, 200, status());
              return;
            }

            if (path === '/key' && method === 'PUT') {
              const body = (await readJson(request)) as { key?: unknown };
              const key = typeof body.key === 'string' ? body.key.trim() : '';
              if (key === '') {
                sendJson(response, 400, { error: 'No key supplied.' });
                return;
              }
              const verified = await verifyKey(key);
              if (!verified.ok) {
                sendJson(response, 400, { error: verified.message });
                return;
              }
              runtimeKey = key;
              sendJson(response, 200, status());
              return;
            }

            if (path === '/key' && method === 'DELETE') {
              runtimeKey = null;
              sendJson(response, 200, status());
              return;
            }

            if (path === '/models' && method === 'GET') {
              const result = await forward('/v1/models?limit=100', { method: 'GET' });
              sendJson(response, result.code, result.body);
              return;
            }

            if (path === '/messages' && method === 'POST') {
              const body = await readJson(request);
              const result = await forward('/v1/messages', {
                method: 'POST',
                body: JSON.stringify(body),
              });
              sendJson(response, result.code, result.body);
              return;
            }

            next();
          } catch (error) {
            const active = activeKey();
            const detail = redact(
              error instanceof Error ? error.message : String(error),
              active?.key ?? null,
            );
            sendJson(response, 500, { error: detail });
          }
        })();
      });
    },
  };
}
