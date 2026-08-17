/**
 * Accounts, balances and the financial position.
 *
 * Accounts have **stable IDs**, so renaming one never changes the meaning of its history. A
 * label is a display concern; an identity is not, and conflating the two is how a column of
 * figures quietly starts meaning something else halfway down.
 *
 * Two kinds only, because that is all the brief's v1 needs:
 *
 *   cash       money you have        (checking, savings)
 *   liability  money you owe         (credit cards, loans)
 *
 * A liability balance is stored as a positive number meaning "amount owed". Paying it reduces
 * the balance. There is no signed-balance convention to get backwards.
 */

import { ZERO, isNegative, sum, type Cents } from './money.ts';
import { type IsoDate } from './dates.ts';

export type AccountId = string & { readonly __accountId?: never };

export type AccountKind = 'cash' | 'liability';

/** How much a balance on this account drags on a credit score. */
export type CreditImpact = 'high' | 'medium' | 'low' | 'none';

export interface CashAccount {
  readonly id: AccountId;
  readonly kind: 'cash';
  readonly name: string;
  /**
   * The balance never to drop below. The brief calls this the cushion, and maintaining it is a
   * hard validation rule rather than a preference.
   */
  readonly cushion: Cents;
}

export interface LiabilityAccount {
  readonly id: AccountId;
  readonly kind: 'liability';
  readonly name: string;
  /** Annual percentage rate, as a fraction: 0.2249 is 22.49%. */
  readonly apr: number;
  readonly minimumPayment: Cents;
  /** Credit limit, where one exists. Loans have none. */
  readonly creditLimit?: Cents;
  /** Weight used when ranking which debt to attack. */
  readonly creditImpact: CreditImpact;
}

export type Account = CashAccount | LiabilityAccount;

export function isCash(account: Account): account is CashAccount {
  return account.kind === 'cash';
}

export function isLiability(account: Account): account is LiabilityAccount {
  return account.kind === 'liability';
}

/** A recurring or one-off obligation that has not been paid yet. */
export interface Commitment {
  readonly id: string;
  readonly name: string;
  readonly amount: Cents;
  /** Day of the month it falls due, 1-31. Clamped to the month's length. */
  readonly dayOfMonth: number;
  /** Which cash account it is paid from. */
  readonly fundedBy: AccountId;
}

/**
 * Balances observed on a given date.
 *
 * A missing balance is **not** zero. Treating a blank as zero would report a card as paid off,
 * so `balances` is a partial map and the absence is detected as an error rather than assumed.
 */
export interface Snapshot {
  readonly date: IsoDate;
  readonly balances: Readonly<Record<AccountId, Cents>>;
  readonly note?: string;
}

/** Everything needed to answer a question, at one moment. */
export interface FinancialState {
  readonly accounts: readonly Account[];
  readonly commitments: readonly Commitment[];
  /** Most recent first is not assumed; use {@link latestSnapshot}. */
  readonly history: readonly Snapshot[];
  /** Day of the month income arrives. Bounds the affordability lookahead. */
  readonly paydayOfMonth: number;
  /** The cash account treated as the primary one for day-to-day spending. */
  readonly primaryCashAccountId: AccountId;
}

export function findAccount(
  accounts: readonly Account[],
  id: AccountId,
): Account | undefined {
  return accounts.find((account) => account.id === id);
}

export function cashAccounts(accounts: readonly Account[]): readonly CashAccount[] {
  return accounts.filter(isCash);
}

export function liabilityAccounts(accounts: readonly Account[]): readonly LiabilityAccount[] {
  return accounts.filter(isLiability);
}

/** The chronologically last snapshot, or undefined when there is no history at all. */
export function latestSnapshot(history: readonly Snapshot[]): Snapshot | undefined {
  if (history.length === 0) return undefined;
  return [...history].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).at(-1);
}

/** History oldest-first, which is the order every trend calculation wants. */
export function chronological(history: readonly Snapshot[]): readonly Snapshot[] {
  return [...history].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function balanceOf(snapshot: Snapshot, id: AccountId): Cents | undefined {
  return snapshot.balances[id];
}

/** IDs of active accounts that the snapshot has no balance for. */
export function missingBalances(
  accounts: readonly Account[],
  snapshot: Snapshot,
): readonly AccountId[] {
  return accounts.filter((account) => snapshot.balances[account.id] === undefined).map((a) => a.id);
}

export function totalCash(accounts: readonly Account[], snapshot: Snapshot): Cents {
  return sum(cashAccounts(accounts).map((a) => snapshot.balances[a.id] ?? ZERO));
}

export function totalDebt(accounts: readonly Account[], snapshot: Snapshot): Cents {
  return sum(liabilityAccounts(accounts).map((a) => snapshot.balances[a.id] ?? ZERO));
}

export function netWorth(accounts: readonly Account[], snapshot: Snapshot): Cents {
  return sum([totalCash(accounts, snapshot), -totalDebt(accounts, snapshot) as Cents]);
}

/** Ordering used when a credit-score-first strategy is applied. Higher is more urgent. */
export const CREDIT_IMPACT_WEIGHT: Readonly<Record<CreditImpact, number>> = {
  high: 3,
  medium: 2,
  low: 1,
  none: 0,
};

export class ModelError extends Error {
  override readonly name = 'ModelError';
}

/**
 * Checks the shape of a state before anything tries to reason about it.
 *
 * These are structural faults — a duplicate ID, a commitment funded from a liability — which
 * make a question meaningless rather than merely risky. Risk is the validation module's job.
 */
export function assertWellFormed(state: FinancialState): void {
  const seen = new Set<AccountId>();
  for (const account of state.accounts) {
    if (seen.has(account.id)) throw new ModelError(`Duplicate account id: ${account.id}`);
    seen.add(account.id);
    if (account.name.trim() === '') throw new ModelError(`Account ${account.id} has no name`);
    if (isCash(account) && isNegative(account.cushion)) {
      throw new ModelError(`Account ${account.id} has a negative cushion`);
    }
    if (isLiability(account)) {
      if (!Number.isFinite(account.apr) || account.apr < 0) {
        throw new ModelError(`Account ${account.id} has an invalid APR: ${account.apr}`);
      }
      if (isNegative(account.minimumPayment)) {
        throw new ModelError(`Account ${account.id} has a negative minimum payment`);
      }
    }
  }

  const primary = findAccount(state.accounts, state.primaryCashAccountId);
  if (primary === undefined) {
    throw new ModelError(`Primary account ${state.primaryCashAccountId} does not exist`);
  }
  if (!isCash(primary)) {
    throw new ModelError(`Primary account ${state.primaryCashAccountId} is not a cash account`);
  }

  for (const commitment of state.commitments) {
    const funder = findAccount(state.accounts, commitment.fundedBy);
    if (funder === undefined) {
      throw new ModelError(`Commitment ${commitment.id} is funded from an unknown account`);
    }
    if (!isCash(funder)) {
      throw new ModelError(`Commitment ${commitment.id} must be funded from a cash account`);
    }
    if (commitment.dayOfMonth < 1 || commitment.dayOfMonth > 31) {
      throw new ModelError(`Commitment ${commitment.id} has an invalid day of month`);
    }
    if (isNegative(commitment.amount)) {
      throw new ModelError(`Commitment ${commitment.id} has a negative amount`);
    }
  }

  if (state.paydayOfMonth < 1 || state.paydayOfMonth > 31) {
    throw new ModelError(`Payday ${state.paydayOfMonth} is not a day of the month`);
  }
}
