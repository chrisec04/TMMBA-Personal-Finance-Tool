/**
 * Test fixtures.
 *
 * Deliberately small and round: every expected value in the tests that use these is worked out
 * by hand in a comment, and that is only practical when the inputs are legible. The demo data in
 * `src/seed` is the realistic one; this is the arithmetic one.
 */

import { parseMoney } from '../money.ts';
import type { AccountId, FinancialState, Snapshot } from '../accounts.ts';

export const CHECKING = 'checking' as AccountId;
export const SAVINGS = 'savings' as AccountId;
export const CARD_A = 'card-a' as AccountId;
export const CARD_B = 'card-b' as AccountId;
export const LOAN = 'loan' as AccountId;

/**
 * checking  $3,000.00  cushion $1,000.00
 * savings   $  500.00  cushion $    0.00
 * card A    $2,000.00  APR 24.00%  min $50.00  high impact
 * card B    $  800.00  APR 18.00%  min $25.00  medium impact
 * loan      $10,000.00 APR  6.00%  min $200.00 low impact
 * rent      $1,200.00 on day 1, from checking
 * payday    day 15
 */
export const STATE: FinancialState = {
  accounts: [
    { id: CHECKING, kind: 'cash', name: 'Checking', cushion: parseMoney('1000.00') },
    { id: SAVINGS, kind: 'cash', name: 'Savings', cushion: parseMoney('0.00') },
    {
      id: CARD_A,
      kind: 'liability',
      name: 'Card A',
      apr: 0.24,
      minimumPayment: parseMoney('50.00'),
      creditLimit: parseMoney('5000.00'),
      creditImpact: 'high',
    },
    {
      id: CARD_B,
      kind: 'liability',
      name: 'Card B',
      apr: 0.18,
      minimumPayment: parseMoney('25.00'),
      creditLimit: parseMoney('3000.00'),
      creditImpact: 'medium',
    },
    {
      id: LOAN,
      kind: 'liability',
      name: 'Loan',
      apr: 0.06,
      minimumPayment: parseMoney('200.00'),
      creditImpact: 'low',
    },
  ],
  commitments: [
    {
      id: 'rent',
      name: 'Rent',
      amount: parseMoney('1200.00'),
      dayOfMonth: 1,
      fundedBy: CHECKING,
    },
  ],
  history: [],
  paydayOfMonth: 15,
  primaryCashAccountId: CHECKING,
};

export const SNAPSHOT: Snapshot = {
  date: '2026-03-05',
  balances: {
    [CHECKING]: parseMoney('3000.00'),
    [SAVINGS]: parseMoney('500.00'),
    [CARD_A]: parseMoney('2000.00'),
    [CARD_B]: parseMoney('800.00'),
    [LOAN]: parseMoney('10000.00'),
  },
};

/** Builds a variant of {@link SNAPSHOT} with specific balances overridden. */
export function withBalances(overrides: Readonly<Record<string, string>>): Snapshot {
  const balances: Record<string, ReturnType<typeof parseMoney>> = { ...SNAPSHOT.balances };
  for (const [id, value] of Object.entries(overrides)) {
    balances[id] = parseMoney(value);
  }
  return { ...SNAPSHOT, balances };
}

/** Builds a snapshot with some balances removed entirely, to test "blank is not zero". */
export function withoutBalances(ids: readonly AccountId[]): Snapshot {
  const balances: Record<string, ReturnType<typeof parseMoney>> = { ...SNAPSHOT.balances };
  for (const id of ids) delete balances[id];
  return { ...SNAPSHOT, balances };
}
