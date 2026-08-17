import { describe, expect, it } from 'vitest';
import { SNAPSHOT, STATE } from '../domain/__fixtures__/state.ts';
import type { CashAccount, FinancialState } from '../domain/accounts.ts';
import { parseMoney } from '../domain/money.ts';
import { FileDataStore } from './DataStore.ts';
import { FileSystemError, MemoryFileSystem } from './FileSystemPort.ts';

const ROOT = '/finance';
const DATA_FILE = `${ROOT}/personal-finance.json`;

function state(): FinancialState {
  return { ...STATE, history: [SNAPSHOT] };
}

function firstCashAccount(): CashAccount {
  const account = state().accounts[0];
  if (account === undefined) throw new Error('fixture has no account');
  if (account.kind !== 'cash') throw new Error('fixture first account is not cash');
  return account;
}

async function seededStore(value: unknown): Promise<{ fs: MemoryFileSystem; store: FileDataStore }> {
  const fs = new MemoryFileSystem();
  await fs.mkdir(ROOT);
  await fs.writeTextFile(DATA_FILE, `${JSON.stringify(value, null, 2)}\n`);
  return { fs, store: new FileDataStore(fs, ROOT) };
}

class FailingRenameFileSystem extends MemoryFileSystem {
  failRenames = false;

  override async rename(from: string, to: string): Promise<void> {
    if (this.failRenames) {
      throw new FileSystemError(`Refusing to rename ${from} -> ${to}`);
    }
    await super.rename(from, to);
  }
}

describe('FileDataStore', () => {
  it('round-trips financial state without changing cents into decimals', async () => {
    const fs = new MemoryFileSystem();
    const store = new FileDataStore(fs, ROOT);

    await store.save(state());

    await expect(store.load()).resolves.toEqual(state());
    expect(await fs.readTextFile(DATA_FILE)).toContain('"cushion": 100000');
    expect(await fs.readTextFile(DATA_FILE)).not.toContain('1000.00');
  });

  it('keeps the previous file if the atomic rename fails', async () => {
    const fs = new FailingRenameFileSystem();
    const store = new FileDataStore(fs, ROOT);
    await store.save(state());
    const original = await fs.readTextFile(DATA_FILE);

    fs.failRenames = true;
    await expect(
      store.save({
        ...state(),
        paydayOfMonth: 16,
      }),
    ).rejects.toThrow(/Refusing to rename/);

    expect(await fs.readTextFile(DATA_FILE)).toBe(original);
    expect(fs.snapshotFiles()).toHaveProperty(`${DATA_FILE}.tmp`);
  });

  it('migrates a pre-version file to v1 on load', async () => {
    const oldFile = state();
    const { store } = await seededStore(oldFile);

    await expect(store.load()).resolves.toEqual(state());
  });

  it('rejects duplicate account ids with a legible error', async () => {
    const duplicate = { ...firstCashAccount(), name: 'Duplicate Checking' };
    const corrupt = {
      version: 1,
      ...state(),
      accounts: [...state().accounts, duplicate],
    };
    const { store } = await seededStore(corrupt);

    await expect(store.load()).rejects.toThrow(/duplicate account id checking/i);
  });

  it('rejects non-integer money values', async () => {
    const corrupt = {
      version: 1,
      ...state(),
      accounts: [
        { ...firstCashAccount(), cushion: 1000.25 },
        ...state().accounts.slice(1),
      ],
    };
    const { store } = await seededStore(corrupt);

    await expect(store.load()).rejects.toThrow(/cushion.*integer number of cents/i);
  });

  it('rejects files with the wrong top-level shape', async () => {
    const { store } = await seededStore({ version: 1, accounts: 'not accounts' });

    await expect(store.load()).rejects.toThrow(/accounts must be an array/i);
  });

  it('writes to a temporary path before replacing the data file', async () => {
    const fs = new MemoryFileSystem();
    const store = new FileDataStore(fs, ROOT);

    await store.save({
      ...state(),
      accounts: [
        { ...firstCashAccount(), cushion: parseMoney('123.45') },
        ...state().accounts.slice(1),
      ],
    });

    expect(fs.writeLog).toEqual([`${DATA_FILE}.tmp`, DATA_FILE]);
  });
});
