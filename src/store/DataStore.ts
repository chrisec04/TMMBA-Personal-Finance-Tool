/**
 * File-backed financial state store.
 *
 * v1 is one human-readable JSON file in the user's chosen data folder. That is enough for a
 * personal tool and keeps recovery straightforward: if the app cannot open the file, the
 * error says which field is wrong instead of pretending an empty budget is safer.
 */

import {
  assertWellFormed,
  type Account,
  type AccountId,
  type Commitment,
  type CreditImpact,
  type FinancialState,
  type Snapshot,
} from '../domain/accounts.ts';
import { isValidIsoDate, type IsoDate } from '../domain/dates.ts';
import { cents, type Cents } from '../domain/money.ts';
import { FileSystemError, joinPath, parentPath, type FileSystemPort } from './FileSystemPort.ts';

export const STORE_SCHEMA_VERSION = 1;
export const DEFAULT_DATA_FILE = 'personal-finance.json';

export class StoreError extends Error {
  override readonly name = 'StoreError';
}

export interface StoreFileV1 {
  readonly version: 1;
  readonly accounts: readonly Account[];
  readonly commitments: readonly Commitment[];
  readonly paydayOfMonth: number;
  readonly primaryCashAccountId: AccountId;
  readonly history: readonly Snapshot[];
}

export interface DataStore {
  exists(): Promise<boolean>;
  load(): Promise<FinancialState | undefined>;
  save(state: FinancialState): Promise<void>;
}

export interface FileDataStoreOptions {
  readonly fileName?: string;
}

type JsonRecord = Record<string, unknown>;

const CREDIT_IMPACTS = new Set(['high', 'medium', 'low', 'none']);

export class FileDataStore implements DataStore {
  private readonly fs: FileSystemPort;
  private readonly root: string;
  private readonly fileName: string;

  constructor(fs: FileSystemPort, root: string, options: FileDataStoreOptions = {}) {
    this.fs = fs;
    this.root = root.replace(/[/\\]+$/, '');
    this.fileName = options.fileName ?? DEFAULT_DATA_FILE;
  }

  private path(): string {
    return joinPath(this.root, this.fileName);
  }

  async exists(): Promise<boolean> {
    return this.fs.exists(this.path());
  }

  async load(): Promise<FinancialState | undefined> {
    const path = this.path();
    let raw: string;
    try {
      raw = await this.fs.readTextFile(path);
    } catch (cause) {
      if (cause instanceof FileSystemError && cause.code === 'NOT_FOUND') return undefined;
      throw cause;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new StoreError(`${path} is not valid JSON. The file may be damaged or mid-write.`);
    }

    return validateFile(migrateFile(parsed, path), path);
  }

  async save(state: FinancialState): Promise<void> {
    const path = this.path();
    const parent = parentPath(path);
    if (parent !== '') await this.fs.mkdir(parent);

    const file = toStoreFile(validateState(state, path));
    await writeJsonAtomically(this.fs, path, file);
  }
}

async function writeJsonAtomically(
  fs: FileSystemPort,
  path: string,
  value: StoreFileV1,
): Promise<void> {
  // The API key is intentionally never written here. This file is portable user data; it is
  // something a user might hand to an accountant, a helper, or a future version of the app.
  const temporary = `${path}.tmp`;
  await fs.writeTextFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, path);
}

function migrateFile(value: unknown, path: string): unknown {
  const record = expectRecord(value, path);
  const rawVersion = record.version;

  if (rawVersion === undefined || rawVersion === 0) {
    // Early prototypes wrote the state shape directly. Keep opening that file deliberately
    // instead of letting an absent version drift into "whatever the current code happens to do".
    return { ...record, version: STORE_SCHEMA_VERSION };
  }

  if (typeof rawVersion !== 'number' || !Number.isSafeInteger(rawVersion)) {
    throw new StoreError(`${path}.version must be an integer schema version`);
  }
  if (rawVersion > STORE_SCHEMA_VERSION) {
    throw new StoreError(
      `${path} was written by a newer version of Personal Finance Tool (schema ${rawVersion}). Update the app before opening it.`,
    );
  }
  if (rawVersion !== STORE_SCHEMA_VERSION) {
    throw new StoreError(`${path} uses unsupported schema version ${rawVersion}`);
  }
  return record;
}

function validateFile(value: unknown, path: string): FinancialState {
  const record = expectRecord(value, path);
  const version = record.version;
  if (version !== STORE_SCHEMA_VERSION) {
    throw new StoreError(`${path}.version must be ${STORE_SCHEMA_VERSION}`);
  }

  const state: FinancialState = {
    accounts: readAccounts(record.accounts, `${path}.accounts`),
    commitments: readCommitments(record.commitments, `${path}.commitments`),
    paydayOfMonth: readDayOfMonth(record.paydayOfMonth, `${path}.paydayOfMonth`),
    primaryCashAccountId: readAccountId(
      record.primaryCashAccountId,
      `${path}.primaryCashAccountId`,
    ),
    history: readHistory(record.history, `${path}.history`),
  };

  return validateState(state, path);
}

function validateState(state: FinancialState, path: string): FinancialState {
  try {
    assertWellFormed(state);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new StoreError(`${path}: ${message}`);
  }
  return state;
}

function toStoreFile(state: FinancialState): StoreFileV1 {
  return {
    version: STORE_SCHEMA_VERSION,
    accounts: state.accounts,
    commitments: state.commitments,
    paydayOfMonth: state.paydayOfMonth,
    primaryCashAccountId: state.primaryCashAccountId,
    history: state.history,
  };
}

function readAccounts(value: unknown, path: string): Account[] {
  const values = expectArray(value, path);
  const seen = new Set<string>();
  return values.map((account, index) => {
    const parsed = readAccount(account, `${path}[${index}]`);
    if (seen.has(parsed.id)) throw new StoreError(`${path} contains duplicate account id ${parsed.id}`);
    seen.add(parsed.id);
    return parsed;
  });
}

function readAccount(value: unknown, path: string): Account {
  const record = expectRecord(value, path);
  const id = readAccountId(record.id, `${path}.id`);
  const name = expectString(record.name, `${path}.name`);
  if (record.kind === 'cash') {
    return {
      id,
      kind: 'cash',
      name,
      cushion: readCents(record.cushion, `${path}.cushion`),
    };
  }
  if (record.kind === 'liability') {
    const creditLimit = record.creditLimit;
    return {
      id,
      kind: 'liability',
      name,
      apr: expectFiniteNumber(record.apr, `${path}.apr`),
      minimumPayment: readCents(record.minimumPayment, `${path}.minimumPayment`),
      ...(creditLimit === undefined
        ? {}
        : { creditLimit: readCents(creditLimit, `${path}.creditLimit`) }),
      creditImpact: readCreditImpact(record.creditImpact, `${path}.creditImpact`),
    };
  }
  throw new StoreError(`${path}.kind must be "cash" or "liability"`);
}

function readCommitments(value: unknown, path: string): Commitment[] {
  return expectArray(value, path).map((commitment, index) =>
    readCommitment(commitment, `${path}[${index}]`),
  );
}

function readCommitment(value: unknown, path: string): Commitment {
  const record = expectRecord(value, path);
  return {
    id: expectString(record.id, `${path}.id`),
    name: expectString(record.name, `${path}.name`),
    amount: readCents(record.amount, `${path}.amount`),
    dayOfMonth: readDayOfMonth(record.dayOfMonth, `${path}.dayOfMonth`),
    fundedBy: readAccountId(record.fundedBy, `${path}.fundedBy`),
  };
}

function readHistory(value: unknown, path: string): Snapshot[] {
  return expectArray(value, path).map((snapshot, index) => readSnapshot(snapshot, `${path}[${index}]`));
}

function readSnapshot(value: unknown, path: string): Snapshot {
  const record = expectRecord(value, path);
  const note = record.note;
  return {
    date: readIsoDate(record.date, `${path}.date`),
    balances: readBalances(record.balances, `${path}.balances`),
    ...(note === undefined ? {} : { note: expectString(note, `${path}.note`) }),
  };
}

function readBalances(value: unknown, path: string): Readonly<Record<AccountId, Cents>> {
  const record = expectRecord(value, path);
  const balances: Record<AccountId, Cents> = {};
  for (const [id, amount] of Object.entries(record)) {
    balances[readAccountId(id, `${path}.${id}.id`)] = readCents(amount, `${path}.${id}`);
  }
  return balances;
}

function readAccountId(value: unknown, path: string): AccountId {
  const id = expectString(value, path);
  if (id.trim() === '') throw new StoreError(`${path} must not be blank`);
  return id as AccountId;
}

function readCreditImpact(value: unknown, path: string): CreditImpact {
  if (typeof value === 'string' && CREDIT_IMPACTS.has(value)) {
    return value as CreditImpact;
  }
  throw new StoreError(`${path} must be "high", "medium", "low", or "none"`);
}

function readIsoDate(value: unknown, path: string): IsoDate {
  const date = expectString(value, path);
  if (!isValidIsoDate(date)) throw new StoreError(`${path} must be a valid YYYY-MM-DD date`);
  return date as IsoDate;
}

function readDayOfMonth(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 31) {
    throw new StoreError(`${path} must be an integer day of the month from 1 to 31`);
  }
  return value;
}

function readCents(value: unknown, path: string): Cents {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new StoreError(`${path} must be an integer number of cents`);
  }
  return cents(value);
}

function expectRecord(value: unknown, path: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StoreError(`${path} must be an object`);
  }
  return value as JsonRecord;
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new StoreError(`${path} must be an array`);
  return value;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new StoreError(`${path} must be a string`);
  return value;
}

function expectFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new StoreError(`${path} must be a finite number`);
  }
  return value;
}
