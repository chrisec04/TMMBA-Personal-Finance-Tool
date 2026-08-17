/**
 * Where the app's data actually lives.
 *
 * Two backings, one contract. On the desktop the state is a JSON file in a folder you choose;
 * in the browser it is a single localStorage entry. The screens neither know nor care which.
 *
 * The important detail is that **both go through the same validation**. It would have been
 * easier for the browser path to `JSON.parse` and cast, but a cast is not a check: a stale
 * entry left behind by an older version, or a hand-edited one, would then sail through and fail
 * much later, somewhere deep in a calculation, as an unreadable error about a missing balance.
 * Instead the string is handed to the same {@link FileDataStore} the desktop uses, over an
 * in-memory filesystem, so migrations and shape checks apply identically and a corrupt entry is
 * rejected here with a legible message.
 */

import type { FinancialState } from '../domain/accounts.ts';
import {
  DEFAULT_DATA_FILE,
  FileDataStore,
  StoreError,
  type DataStore,
} from '../store/DataStore.ts';
import { MemoryFileSystem } from '../store/FileSystemPort.ts';
import { TauriFileSystem } from '../store/TauriFileSystem.ts';
import { isTauri } from '../claude/ClaudePort.ts';

export interface UiPersistence {
  load(): Promise<FinancialState | null>;
  save(state: FinancialState): Promise<void>;
  /** Forgets everything, so the app falls back to the demo dataset. */
  clear(): Promise<void>;
  /** Shown in Settings so it is obvious where the data is going. */
  describe(): string;
}

const KEY = 'personal-finance-tool:state:v1';

/** Runs a JSON string through the real store, purely for its validation and migrations. */
async function parseThroughStore(raw: string): Promise<FinancialState> {
  const fs = new MemoryFileSystem();
  await fs.writeTextFile(DEFAULT_DATA_FILE, raw);
  const store: DataStore = new FileDataStore(fs, '');
  const state = await store.load();
  if (state === undefined) {
    throw new StoreError('The saved data could not be read.');
  }
  return state;
}

/** Serialises through the store too, so what is written always matches what can be read. */
async function serialiseThroughStore(state: FinancialState): Promise<string> {
  const fs = new MemoryFileSystem();
  const store: DataStore = new FileDataStore(fs, '');
  await store.save(state);
  return fs.readTextFile(DEFAULT_DATA_FILE);
}

export const browserPersistence: UiPersistence = {
  async load() {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(KEY);
    if (raw === null) return null;

    try {
      return await parseThroughStore(raw);
    } catch (error) {
      // A stale or corrupt entry must not brick the app on every reload. Drop it, say so, and
      // let the caller fall back to the demo dataset.
      console.warn(
        'Saved data could not be read and has been discarded:',
        error instanceof Error ? error.message : error,
      );
      localStorage.removeItem(KEY);
      return null;
    }
  },

  async save(state) {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(KEY, await serialiseThroughStore(state));
  },

  clear() {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(KEY);
    return Promise.resolve();
  },

  describe() {
    return 'This browser\u2019s local storage';
  },
};

/** Desktop persistence: a real JSON file, written atomically, in a folder you choose. */
export function filePersistence(folder: string): UiPersistence {
  const store: DataStore = new FileDataStore(new TauriFileSystem(), folder);

  return {
    async load() {
      return (await store.load()) ?? null;
    },
    async save(state) {
      await store.save(state);
    },
    clear() {
      // Deliberately not a delete. Removing someone's records because they clicked "clear" in a
      // settings screen is not a recoverable mistake; the app forgets the folder instead, and
      // the file stays exactly where it is.
      return Promise.resolve();
    },
    describe() {
      return `${folder}/${DEFAULT_DATA_FILE}`;
    },
  };
}

/**
 * The backing for this environment.
 *
 * The desktop build only gets a file once a folder has been chosen; until then it behaves like
 * the browser, which keeps first-run working before any decision has been made.
 */
export function persistenceFor(folder: string | undefined): UiPersistence {
  return isTauri() && folder !== undefined && folder !== ''
    ? filePersistence(folder)
    : browserPersistence;
}
