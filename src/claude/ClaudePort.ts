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

/** Where the key lives and whether we have one. The key itself is never exposed. */
export interface KeyStatus {
  readonly configured: boolean;
  readonly source: 'runtime' | 'env' | 'keychain' | 'none';
  /** Last four characters, for identifying which key was pasted. Never the whole key. */
  readonly hint: string | null;
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
  /** Whether a key is configured, and where it came from. Never returns the key. */
  keyStatus(): Promise<KeyStatus>;
  /** Stores a key after verifying it works. Throws {@link ClaudeError} if it does not. */
  setKey(key: string): Promise<KeyStatus>;
  clearKey(): Promise<KeyStatus>;
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
