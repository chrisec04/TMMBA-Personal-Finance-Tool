// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  describeConnection,
  NEVER_CHECKED,
  NO_KEY,
  VERIFICATION_MAX_AGE_MS,
  type KeyStatus,
  type VerificationState,
} from '../claude/ClaudePort.ts';
import { shouldAutoVerifyConnection } from './connectionState.ts';

const now = Date.parse('2026-08-16T12:00:00.000Z');

function status(
  state: VerificationState,
  checkedAt: string | null = null,
  detail: string | null = null,
): KeyStatus {
  return {
    configured: true,
    source: 'keychain',
    hint: '1234',
    connection: {
      state,
      checkedAt,
      detail,
      latencyMs: state === 'ok' ? 120 : null,
    },
  };
}

describe('shouldAutoVerifyConnection', () => {
  it('verifies a configured key that has not been checked this session', () => {
    expect(shouldAutoVerifyConnection({ status: status('unverified'), verificationInFlight: false, now })).toBe(true);
  });

  it('does not verify when no key is configured', () => {
    expect(shouldAutoVerifyConnection({ status: NO_KEY, verificationInFlight: false, now })).toBe(false);
  });

  it('does not verify a fresh successful check', () => {
    expect(shouldAutoVerifyConnection({
      status: status('ok', new Date(now - 1_000).toISOString()),
      verificationInFlight: false,
      now,
    })).toBe(false);
  });

  it('verifies a stale successful check', () => {
    expect(shouldAutoVerifyConnection({
      status: status('ok', new Date(now - VERIFICATION_MAX_AGE_MS - 1).toISOString()),
      verificationInFlight: false,
      now,
    })).toBe(true);
  });

  it('does not automatically retry a failed check', () => {
    expect(shouldAutoVerifyConnection({
      status: status('failed', new Date(now).toISOString(), 'The key was rejected.'),
      verificationInFlight: false,
      now,
    })).toBe(false);
  });

  it('does not start a second check while one is already running', () => {
    expect(shouldAutoVerifyConnection({ status: status('unverified'), verificationInFlight: true, now })).toBe(false);
  });
});

describe('describeConnection', () => {
  it('reaches the idle tone when no key is configured', () => {
    expect(describeConnection(NO_KEY, now)).toMatchObject({ tone: 'idle', canVerify: false });
  });

  it('reaches the warn tone for an unverified stored key', () => {
    expect(describeConnection(status('unverified'), now)).toMatchObject({ tone: 'warn' });
  });

  it('reaches the ok tone for a fresh successful check', () => {
    expect(describeConnection(status('ok', new Date(now).toISOString()), now)).toMatchObject({ tone: 'ok' });
  });

  it('reaches the bad tone and surfaces the failure detail', () => {
    expect(describeConnection(status('failed', new Date(now).toISOString(), 'Could not reach Anthropic.'), now)).toMatchObject({
      tone: 'bad',
      detail: 'Could not reach Anthropic.',
    });
  });

  it('describes a stale ok check differently from a fresh one', () => {
    const fresh = describeConnection(status('ok', new Date(now).toISOString()), now);
    const stale = describeConnection(status('ok', new Date(now - VERIFICATION_MAX_AGE_MS - 1).toISOString()), now);
    expect(stale.tone).toBe('warn');
    expect(stale.label).not.toBe(fresh.label);
    expect(stale.detail).not.toBe(fresh.detail);
  });

  it('treats a configured key with no check timestamp as unverified', () => {
    expect(describeConnection({ ...status('ok'), connection: NEVER_CHECKED }, now).tone).toBe('warn');
  });
});
