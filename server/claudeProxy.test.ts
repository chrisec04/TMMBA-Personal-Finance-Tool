import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NEVER_CHECKED, type KeyStatus } from '../src/claude/ClaudePort.ts';
import { handleClaudeProxyCall, redact, resetClaudeProxyForTests } from './claudeProxy.ts';

const RUNTIME_KEY = 'sk-ant-runtime_1234567890SECRET';
const ENV_KEY = 'sk-ant-env_1234567890SECRET';
const ECHOED_KEY = 'sk-ant-upstreamEcho_abcdefghi';

function anthropicOk(body: unknown = { data: [{ id: 'claude-test' }] }): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function anthropicError(status: number, body: string): Response {
  return new Response(body, { status });
}

function asStatus(body: unknown): KeyStatus {
  return body as KeyStatus;
}

function expectNoFakeKey(value: unknown): void {
  const text = JSON.stringify(value);
  expect(text).not.toContain(RUNTIME_KEY);
  expect(text).not.toContain(ENV_KEY);
  expect(text).not.toContain(ECHOED_KEY);
}

describe('redact', () => {
  it('removes the exact key everywhere it appears', () => {
    const text = `first ${RUNTIME_KEY} second ${RUNTIME_KEY}`;

    const safe = redact(text, RUNTIME_KEY);

    expect(safe).toBe('first [redacted] second [redacted]');
    expect(safe).not.toContain(RUNTIME_KEY);
  });

  it('removes keys embedded in JSON text', () => {
    const safe = redact(JSON.stringify({ error: `bad ${RUNTIME_KEY}` }), RUNTIME_KEY);

    expect(safe).toBe('{"error":"bad [redacted]"}');
    expect(safe).not.toContain(RUNTIME_KEY);
  });

  it('removes a different key-shaped value even when it was never stored', () => {
    const safe = redact(`upstream echoed ${ECHOED_KEY}`, RUNTIME_KEY);

    expect(safe).toBe('upstream echoed [redacted]');
    expect(safe).not.toContain(ECHOED_KEY);
  });

  it('does not over-redact a bare key prefix', () => {
    expect(redact('prefix sk-ant- remains', null)).toBe('prefix sk-ant- remains');
  });

  it('handles empty and null keys by redacting only key-shaped text', () => {
    expect(redact(`empty ${ECHOED_KEY}`, '')).toBe('empty [redacted]');
    expect(redact(`null ${ECHOED_KEY}`, null)).toBe('null [redacted]');
  });

  it('leaves unrelated text alone', () => {
    expect(redact('nothing sensitive here', RUNTIME_KEY)).toBe('nothing sensitive here');
  });
});

describe('claude proxy connection checks', () => {
  beforeEach(() => {
    resetClaudeProxyForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env['ANTHROPIC_API_KEY'];
  });

  it('reports an env key as unverified, then ok after a successful verify', async () => {
    process.env['ANTHROPIC_API_KEY'] = ENV_KEY;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(anthropicOk());
    vi.stubGlobal('fetch', fetchMock);

    const initial = await handleClaudeProxyCall({ path: '/key', method: 'GET' });
    expect(initial?.code).toBe(200);
    expect(asStatus(initial?.body).connection).toEqual(NEVER_CHECKED);

    const verified = await handleClaudeProxyCall({ path: '/verify', method: 'POST' });

    expect(verified?.code).toBe(200);
    const body = asStatus(verified?.body);
    expect(body).toMatchObject({ configured: true, source: 'env', hint: 'CRET' });
    expect(body.connection.state).toBe('ok');
    expect(body.connection.checkedAt).not.toBeNull();
    expect(body.connection.latencyMs).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models?limit=1',
      expect.objectContaining({ headers: expect.objectContaining({ 'x-api-key': ENV_KEY }) }),
    );
    expectNoFakeKey(verified?.body);
  });

  it('records a failed verification on a 401 without returning the key', async () => {
    process.env['ANTHROPIC_API_KEY'] = ENV_KEY;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(anthropicError(401, `bad ${ENV_KEY} ${ECHOED_KEY}`)));

    const result = await handleClaudeProxyCall({ path: '/verify', method: 'POST' });

    expect(result?.code).toBe(200);
    const body = asStatus(result?.body);
    expect(body.connection.state).toBe('failed');
    expect(body.connection.detail).toContain('rejected');
    expect(body.connection.detail).toContain('[redacted]');
    expectNoFakeKey(result?.body);
  });

  it('stores a successful PUT verification as the initial connection state', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(anthropicOk()));

    const result = await handleClaudeProxyCall({ path: '/key', method: 'PUT', body: { key: RUNTIME_KEY } });

    expect(result?.code).toBe(200);
    const body = asStatus(result?.body);
    expect(body).toMatchObject({ configured: true, source: 'runtime', hint: 'CRET' });
    expect(body.connection.state).toBe('ok');
    expectNoFakeKey(result?.body);
  });

  it('downgrades an ok key to failed when messages is rejected', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(anthropicOk());
    fetchMock.mockResolvedValueOnce(anthropicError(403, `forbidden ${RUNTIME_KEY} ${ECHOED_KEY}`));
    vi.stubGlobal('fetch', fetchMock);

    const saved = await handleClaudeProxyCall({ path: '/key', method: 'PUT', body: { key: RUNTIME_KEY } });
    expect(asStatus(saved?.body).connection.state).toBe('ok');

    const rejected = await handleClaudeProxyCall({ path: '/messages', method: 'POST', body: { messages: [] } });
    const status = await handleClaudeProxyCall({ path: '/key', method: 'GET' });

    expect(rejected?.code).toBe(403);
    expectNoFakeKey(rejected?.body);
    const body = asStatus(status?.body);
    expect(body.connection.state).toBe('failed');
    expect(body.connection.detail).toContain('rejected');
    expectNoFakeKey(status?.body);
  });

  it('marks rate limits as service failures rather than silent key success', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(anthropicOk());
    fetchMock.mockResolvedValueOnce(anthropicError(429, `quota ${RUNTIME_KEY}`));
    vi.stubGlobal('fetch', fetchMock);

    await handleClaudeProxyCall({ path: '/key', method: 'PUT', body: { key: RUNTIME_KEY } });
    const limited = await handleClaudeProxyCall({ path: '/messages', method: 'POST', body: { messages: [] } });
    const status = await handleClaudeProxyCall({ path: '/key', method: 'GET' });

    expect(limited?.code).toBe(429);
    const body = asStatus(status?.body);
    expect(body.connection.state).toBe('failed');
    expect(body.connection.detail).toContain('service or quota problem');
    expectNoFakeKey(limited?.body);
    expectNoFakeKey(status?.body);
  });

  it('clearing the key resets the connection to never checked', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(anthropicOk()));

    await handleClaudeProxyCall({ path: '/key', method: 'PUT', body: { key: RUNTIME_KEY } });
    const cleared = await handleClaudeProxyCall({ path: '/key', method: 'DELETE' });

    expect(cleared?.code).toBe(200);
    expect(asStatus(cleared?.body)).toEqual({ configured: false, source: 'none', hint: null, connection: NEVER_CHECKED });
    expectNoFakeKey(cleared?.body);
  });
});
