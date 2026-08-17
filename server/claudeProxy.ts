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
import { NEVER_CHECKED, type ConnectionCheck, type KeyStatus } from '../src/claude/ClaudePort.ts';

const ANTHROPIC_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

/** Where the current key came from. `env` is the automation fallback. */
export type KeySource = 'runtime' | 'env' | 'none';

/**
 * The key, held only here.
 *
 * A module-level binding rather than anything persisted. There is deliberately no code path
 * that writes this value anywhere.
 */
let runtimeKey: string | null = null;
let connection: ConnectionCheck = NEVER_CHECKED;

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
  if (active === null) {
    return { configured: false, source: 'none', hint: null, connection: NEVER_CHECKED };
  }
  return { configured: true, source: active.source, hint: active.key.slice(-4), connection };
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

function failureDetail(code: number, detail: string): string {
  if (code === 401 || code === 403) {
    return `The key was rejected by Anthropic (${code}). ${detail}`.trim();
  }
  if (code === 429) {
    return `Anthropic rate-limited the request (429). This may be a service or quota problem, not proof the key is wrong. ${detail}`.trim();
  }
  if (code >= 500) {
    return `Anthropic returned a service error (${code}). This is not proof the key is wrong. ${detail}`.trim();
  }
  return `Anthropic returned ${code}. ${detail}`.trim();
}

async function checkConnection(key: string): Promise<ConnectionCheck> {
  const started = performance.now();
  try {
    const response = await fetch(`${ANTHROPIC_BASE}/v1/models?limit=1`, {
      headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
    });
    const latencyMs = Math.round(performance.now() - started);
    const checkedAt = new Date().toISOString();
    if (response.ok) {
      return { state: 'ok', checkedAt, detail: 'Anthropic answered.', latencyMs };
    }
    const detail = redact(await response.text(), key).slice(0, 300);
    return { state: 'failed', checkedAt, detail: failureDetail(response.status, detail), latencyMs };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - started);
    const detail = redact(error instanceof Error ? error.message : String(error), key);
    return {
      state: 'failed',
      checkedAt: new Date().toISOString(),
      detail: `Could not reach Anthropic: ${detail}`,
      latencyMs,
    };
  }
}

/** Verifies a key is real before we accept it, so a typo fails in Settings and not mid-task. */
async function verifyKey(key: string): Promise<{ ok: true; check: ConnectionCheck } | { ok: false; message: string }> {
  const check = await checkConnection(key);
  if (check.state === 'ok') return { ok: true, check };
  return { ok: false, message: check.detail ?? 'Anthropic rejected the connection check.' };
}

function recordFailedConnection(code: number, safe: string, latencyMs: number): void {
  connection = {
    state: 'failed',
    checkedAt: new Date().toISOString(),
    detail: failureDetail(code, safe.slice(0, 300)),
    latencyMs,
  };
}

/** Forwards a request upstream, attaching the key server-side. */
async function forward(
  path: string,
  init: { method: string; body?: string },
  options: { recordFailure: boolean },
): Promise<{ code: number; body: unknown }> {
  const active = activeKey();
  if (active === null) {
    return { code: 400, body: { error: 'No API key configured.' } };
  }

  const started = performance.now();
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
      if (options.recordFailure) recordFailedConnection(response.status, safe, Math.round(performance.now() - started));
      return { code: response.status, body: { error: safe.slice(0, 1000) } };
    }
    return { code: 200, body: JSON.parse(safe) as unknown };
  } catch (error) {
    const detail = redact(error instanceof Error ? error.message : String(error), active.key);
    if (options.recordFailure) {
      connection = {
        state: 'failed',
        checkedAt: new Date().toISOString(),
        detail: `Upstream request failed: ${detail}`,
        latencyMs: Math.round(performance.now() - started),
      };
    }
    return { code: 502, body: { error: `Upstream request failed: ${detail}` } };
  }
}

export interface ClaudeProxyCall {
  readonly path: string;
  readonly method: string;
  readonly body?: unknown;
}

export type ClaudeProxyResult = { readonly code: number; readonly body: unknown } | null;

export async function handleClaudeProxyCall(call: ClaudeProxyCall): Promise<ClaudeProxyResult> {
  if (call.path === '/key' && call.method === 'GET') {
    return { code: 200, body: status() };
  }

  if (call.path === '/key' && call.method === 'PUT') {
    const body = call.body as { key?: unknown };
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    if (key === '') {
      return { code: 400, body: { error: 'No key supplied.' } };
    }
    const verified = await verifyKey(key);
    if (!verified.ok) {
      return { code: 400, body: { error: verified.message } };
    }
    runtimeKey = key;
    connection = verified.check;
    return { code: 200, body: status() };
  }

  if (call.path === '/key' && call.method === 'DELETE') {
    runtimeKey = null;
    connection = NEVER_CHECKED;
    return { code: 200, body: status() };
  }

  if (call.path === '/verify' && call.method === 'POST') {
    const active = activeKey();
    if (active === null) return { code: 200, body: status() };
    connection = await checkConnection(active.key);
    return { code: 200, body: status() };
  }

  if (call.path === '/models' && call.method === 'GET') {
    return forward('/v1/models?limit=100', { method: 'GET' }, { recordFailure: false });
  }

  if (call.path === '/messages' && call.method === 'POST') {
    return forward('/v1/messages', {
      method: 'POST',
      body: JSON.stringify(call.body ?? {}),
    }, { recordFailure: true });
  }

  return null;
}

export function resetClaudeProxyForTests(): void {
  runtimeKey = null;
  connection = NEVER_CHECKED;
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
            const body = method === 'GET' || method === 'DELETE' ? {} : await readJson(request);
            const result = await handleClaudeProxyCall({ path, method, body });
            if (result === null) {
              next();
              return;
            }
            sendJson(response, result.code, result.body);
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
