import { describe, expect, it } from 'vitest';
import {
  assertWellFormed,
  balanceOf,
  cashAccounts,
  chronological,
  CREDIT_IMPACT_WEIGHT,
  findAccount,
  isCash,
  isLiability,
  latestSnapshot,
  liabilityAccounts,
  missingBalances,
  ModelError,
  netWorth,
  totalCash,
  totalDebt,
  type AccountId,
  type Commitment,
  type FinancialState,
} from './accounts.ts';
import { CARD_A, CARD_B, CHECKING, LOAN, SAVINGS, SNAPSHOT, STATE, withBalances, withoutBalances } from './__fixtures__/state.ts';
import { formatMoney, parseMoney } from './money.ts';

function expectModelError(state: FinancialState): void {
  expect(() => assertWellFormed(state)).toThrow(ModelError);
}

function commitmentFixture(): Commitment {
  const commitment = STATE.commitments.find((entry) => entry.id === 'rent');
  if (commitment === undefined) throw new Error('Fixture commitment missing');
  return commitment;
}

describe('account classification and lookup', () => {
  it('narrows cash and liability accounts by kind', () => {
    const checking = findAccount(STATE.accounts, CHECKING);
    const card = findAccount(STATE.accounts, CARD_A);

    expect(checking).toBeDefined();
    expect(card).toBeDefined();
    expect(checking !== undefined && isCash(checking) ? checking.cushion : undefined).toBe(parseMoney('1000.00'));
    expect(card !== undefined && isLiability(card) ? card.apr : undefined).toBe(0.24);
  });

  it('finds accounts by stable id and filters by account kind', () => {
    expect(findAccount(STATE.accounts, CARD_B)?.name).toBe('Card B');
    expect(cashAccounts(STATE.accounts).map((account) => account.id)).toEqual([CHECKING, SAVINGS]);
    expect(liabilityAccounts(STATE.accounts).map((account) => account.id)).toEqual([CARD_A, CARD_B, LOAN]);
  });
});

describe('snapshots and balances', () => {
  const older = { ...SNAPSHOT, date: '2026-01-01' as const };
  const newer = { ...SNAPSHOT, date: '2026-04-01' as const };

  it('finds the latest snapshot and orders history chronologically even when input is unsorted', () => {
    const input = [SNAPSHOT, newer, older];

    expect(latestSnapshot(input)).toBe(newer);
    expect(chronological(input).map((snapshot) => snapshot.date)).toEqual([
      '2026-01-01',
      '2026-03-05',
      '2026-04-01',
    ]);
  });

  it('handles empty history without inventing a snapshot', () => {
    expect(latestSnapshot([])).toBeUndefined();
    expect(chronological([])).toEqual([]);
  });

  it('reads balances and reports missing balances without treating blanks as zero', () => {
    const missingCard = withoutBalances([CARD_B]);

    expect(formatMoney(balanceOf(SNAPSHOT, CHECKING) ?? parseMoney('0.00'))).toBe('$3,000.00');
    expect(balanceOf(missingCard, CARD_B)).toBeUndefined();
    expect(missingBalances(STATE.accounts, missingCard)).toEqual([CARD_B]);
  });
});

describe('position totals', () => {
  it('totals cash, debt, and net worth as cash minus debt', () => {
    expect(formatMoney(totalCash(STATE.accounts, SNAPSHOT))).toBe('$3,500.00');
    expect(formatMoney(totalDebt(STATE.accounts, SNAPSHOT))).toBe('$12,800.00');
    expect(formatMoney(netWorth(STATE.accounts, SNAPSHOT))).toBe('-$9,300.00');
  });

  it('can report negative net worth when debts exceed cash', () => {
    const snapshot = withBalances({ [CHECKING]: '100.00', [SAVINGS]: '0.00', [CARD_A]: '500.00' });

    expect(formatMoney(netWorth(STATE.accounts, snapshot))).toBe('-$11,200.00');
  });

  it('orders credit impact weights from high down to none', () => {
    expect(CREDIT_IMPACT_WEIGHT.high).toBeGreaterThan(CREDIT_IMPACT_WEIGHT.medium);
    expect(CREDIT_IMPACT_WEIGHT.medium).toBeGreaterThan(CREDIT_IMPACT_WEIGHT.low);
    expect(CREDIT_IMPACT_WEIGHT.low).toBeGreaterThan(CREDIT_IMPACT_WEIGHT.none);
  });
});

describe('well-formed state validation', () => {
  it('accepts the valid fixture state', () => {
    expect(() => assertWellFormed(STATE)).not.toThrow();
  });

  it('rejects duplicate account ids', () => {
    const checking = findAccount(STATE.accounts, CHECKING);
    if (checking === undefined) throw new Error('Fixture account missing');

    expectModelError({ ...STATE, accounts: [...STATE.accounts, { ...checking }] });
  });

  it('rejects an empty account name', () => {
    expectModelError({
      ...STATE,
      accounts: STATE.accounts.map((account) =>
        account.id === CHECKING ? { ...account, name: '   ' } : account,
      ),
    });
  });

  it('rejects a negative cash cushion', () => {
    expectModelError({
      ...STATE,
      accounts: STATE.accounts.map((account) =>
        account.id === CHECKING && account.kind === 'cash'
          ? { ...account, cushion: parseMoney('-1.00') }
          : account,
      ),
    });
  });

  it('rejects negative and non-finite APRs', () => {
    for (const apr of [-0.01, Number.POSITIVE_INFINITY]) {
      expectModelError({
        ...STATE,
        accounts: STATE.accounts.map((account) =>
          account.id === CARD_A && account.kind === 'liability' ? { ...account, apr } : account,
        ),
      });
    }
  });

  it('rejects a negative minimum payment', () => {
    expectModelError({
      ...STATE,
      accounts: STATE.accounts.map((account) =>
        account.id === CARD_A && account.kind === 'liability'
          ? { ...account, minimumPayment: parseMoney('-1.00') }
          : account,
      ),
    });
  });

  it('rejects a primary account that does not exist', () => {
    expectModelError({ ...STATE, primaryCashAccountId: 'missing' as AccountId });
  });

  it('rejects a primary account that is not cash', () => {
    expectModelError({ ...STATE, primaryCashAccountId: CARD_A });
  });

  it('rejects a commitment funded from an unknown account', () => {
    expectModelError({
      ...STATE,
      commitments: [{ ...commitmentFixture(), fundedBy: 'missing' as AccountId }],
    });
  });

  it('rejects a commitment funded from a liability', () => {
    expectModelError({
      ...STATE,
      commitments: [{ ...commitmentFixture(), fundedBy: CARD_A }],
    });
  });

  it('rejects commitment days outside 1 through 31', () => {
    for (const dayOfMonth of [0, 32]) {
      expectModelError({
        ...STATE,
        commitments: [{ ...commitmentFixture(), dayOfMonth }],
      });
    }
  });

  it('rejects a negative commitment amount', () => {
    expectModelError({
      ...STATE,
      commitments: [{ ...commitmentFixture(), amount: parseMoney('-1.00') }],
    });
  });

  it('rejects payday values outside 1 through 31', () => {
    for (const paydayOfMonth of [0, 32]) {
      expectModelError({ ...STATE, paydayOfMonth });
    }
  });
});
