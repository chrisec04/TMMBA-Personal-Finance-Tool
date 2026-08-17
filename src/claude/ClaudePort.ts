/**
 * The Claude boundary.
 *
 * The single most important rule in this codebase is stated here because this is the only file
 * where it could be broken:
 *
 *   **Claude never produces a number that the tool presents as fact.**
 *
 * Every balance, payment, projection and total shown in the UI comes from the deterministic
 * engine in `src/domain`, which is covered by the twenty-scenario gate. Claude is asked for
 * judgement — why an ordering makes sense, what the tradeoff costs, what to watch — and any
 * figure it happens to quote is treated as a *claim* to be checked against the engine, not as
 * information. See `crosscheck.ts`.
 *
 * The port exists so that the same reasoning runs against three transports without the domain
 * or the UI knowing which: Rust over IPC in the packaged app, a localhost proxy in browser dev,
 * and a recorded stub with no network at all.
 */

export interface ClaudeMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface ClaudeRequest {
  readonly system: string;
  readonly messages: readonly ClaudeMessage[];
  readonly model: string;
  readonly maxTokens: number;
}

export interface ClaudeReply {
  readonly text: string;
  /** Absent for the stub, which does no work. */
  readonly model?: string;
  readonly latencyMs: number;
  /** True when the reply came from a recording rather than the API. */
  readonly fromRecording: boolean;
}

export interface ModelInfo {
  readonly id: string;
  readonly displayName?: string;
}

/**
 * Whether a stored key has actually been shown to work.
 *
 * The distinction this type exists to enforce: **holding a key is not the same as having a
 * working connection.** A key sits in the OS keychain across restarts, so an app that reports
 * "connected" merely because one is stored will keep saying so after the key is revoked, after
 * the credit runs out, and while the network is down.
 *
 * Every transport must therefore report not just *whether* it has a key but *when it last
 * proved that key works*, so the UI can say something honest instead of something optimistic.
 */
export type VerificationState =
  /** A key is stored but has not been exercised against the API this session. */
  | 'unverified'
  /** A real call succeeded at {@link ConnectionCheck.checkedAt}. */
  | 'ok'
  /** A real call was attempted and failed. {@link ConnectionCheck.detail} says why. */
  | 'failed';

export interface ConnectionCheck {
  readonly state: VerificationState;
  /** ISO timestamp of the last live call, or null if one has never been made. */
  readonly checkedAt: string | null;
  /** What happened. On failure this is the reason, already stripped of anything key-shaped. */
  readonly detail: string | null;
  /** Round-trip time of the last check, when there was one. */
  readonly latencyMs: number | null;
}

export const NEVER_CHECKED: ConnectionCheck = {
  state: 'unverified',
  checkedAt: null,
  detail: null,
  latencyMs: null,
};

/** Where the key lives, whether we have one, and whether it currently works. */
export interface KeyStatus {
  readonly configured: boolean;
  readonly source: 'runtime' | 'env' | 'keychain' | 'none';
  /** Last four characters, for identifying which key was pasted. Never the whole key. */
  readonly hint: string | null;
  readonly connection: ConnectionCheck;
}

export const NO_KEY: KeyStatus = {
  configured: false,
  source: 'none',
  hint: null,
  connection: NEVER_CHECKED,
};

/**
 * How long a successful check stays meaningful.
 *
 * Ten minutes is a judgement call, not a fact about the API. It is short enough that a key
 * revoked mid-session stops being advertised as working fairly quickly, and long enough that
 * the app is not making a network call every time someone opens Settings.
 */
export const VERIFICATION_MAX_AGE_MS = 10 * 60 * 1000;

export function isStale(check: ConnectionCheck, now: number = Date.now()): boolean {
  if (check.state !== 'ok' || check.checkedAt === null) return true;
  const at = Date.parse(check.checkedAt);
  return Number.isNaN(at) || now - at > VERIFICATION_MAX_AGE_MS;
}

export interface ConnectionSummary {
  readonly label: string;
  readonly tone: 'ok' | 'warn' | 'bad' | 'idle';
  readonly detail: string;
  /** True when a live check would tell the user something they do not already know. */
  readonly canVerify: boolean;
}

function ago(checkedAt: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(checkedAt)) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}

/**
 * The one place the connection badge's wording is decided.
 *
 * Kept here rather than in the UI so that "connected" cannot come to mean one thing on the
 * Settings screen and another on the Recommendation screen — and so it can be tested.
 */
export function describeConnection(
  status: KeyStatus,
  now: number = Date.now(),
): ConnectionSummary {
  if (!status.configured) {
    return {
      label: 'No key \u2014 running on recorded responses',
      tone: 'idle',
      detail:
        'Every figure is still calculated locally. Add a key to replace the recorded commentary with live analysis.',
      canVerify: false,
    };
  }

  const { connection } = status;

  if (connection.state === 'failed') {
    return {
      label: 'Key rejected',
      tone: 'bad',
      detail: connection.detail ?? 'The last call to Anthropic failed.',
      canVerify: true,
    };
  }

  if (connection.state === 'unverified' || connection.checkedAt === null) {
    return {
      label: 'Key saved \u2014 not yet checked',
      tone: 'warn',
      // Said plainly on purpose. A stored key is evidence of nothing until it is used.
      detail:
        'A key is stored but has not been used yet this session, so it is not known to work. Run a connection test to find out.',
      canVerify: true,
    };
  }

  if (isStale(connection, now)) {
    return {
      label: `Connected \u2014 last checked ${ago(connection.checkedAt, now)}`,
      tone: 'warn',
      detail:
        'The last successful check was a while ago, so the key may have changed since. Run a connection test to confirm.',
      canVerify: true,
    };
  }

  const latency = connection.latencyMs === null ? '' : ` in ${connection.latencyMs}ms`;
  return {
    label: `Connected \u2014 checked ${ago(connection.checkedAt, now)}`,
    tone: 'ok',
    detail: `Anthropic answered${latency}, so this key works.`,
    canVerify: true,
  };
}

export class ClaudeError extends Error {
  override readonly name = 'ClaudeError';
  constructor(
    message: string,
    readonly kind: 'no-key' | 'rejected' | 'network' | 'malformed' = 'network',
  ) {
    super(message);
  }
}

/**
 * The transport contract.
 *
 * Deliberately narrow. Anything richer would tempt a caller into asking Claude for something
 * the engine should be computing.
 */
export interface ClaudePort {
  /** Whether a key is configured and what is known about it. Never returns the key. */
  keyStatus(): Promise<KeyStatus>;
  /** Stores a key after verifying it works. Throws {@link ClaudeError} if it does not. */
  setKey(key: string): Promise<KeyStatus>;
  clearKey(): Promise<KeyStatus>;
  /**
   * Makes a real call to Anthropic and records what happened.
   *
   * Distinct from {@link keyStatus}, which only reports what is already known. This is the only
   * method that can move a key from `unverified` to `ok`.
   */
  verifyConnection(): Promise<KeyStatus>;
  /** Available models, for the picker. Empty when no key is configured. */
  listModels(): Promise<readonly ModelInfo[]>;
  send(request: ClaudeRequest): Promise<ClaudeReply>;
}

/** The default when nothing has been chosen yet. Overridable from Settings. */
export const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';

/**
 * Runtime detection of which transport to use.
 *
 * Tauri injects `__TAURI_INTERNALS__` into the window; its absence means we are in a browser,
 * where the dev proxy is the only way to reach the API.
 */
export function isTauri(): boolean {
  return typeof globalThis === 'object' && '__TAURI_INTERNALS__' in globalThis;
}
