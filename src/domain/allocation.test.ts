/**
 * Allocation tests.
 *
 * Every expected figure below is worked out by hand in the comment above it. That is the point:
 * an assertion copied from the code's own output proves only that the code is consistent, not
 * that it is right. The brief's gate is 100% arithmetic accuracy, and this is where it is met.
 */

import { describe, expect, it } from 'vitest';
import { formatMoney, parseMoney } from './money.ts';
import { CARD_A, CARD_B, CHECKING, LOAN, STATE, SNAPSHOT, withBalances } from './__fixtures__/state.ts';
import { buildPlan, fundsAvailableForDebt, recommend, type StrategyId } from './allocation.ts';

const AS_OF = '2026-03-05';

/** Payments keyed by account, for terse assertions. */
function paid(plan: { payments: readonly { accountId: string; amount: number }[] }): Record<string, string> {
  return Object.fromEntries(plan.payments.map((p) => [p.accountId, formatMoney(p.amount as never)]));
}

function closing(plan: {
  payments: readonly { accountId: string; closingBalance: number }[];
}): Record<string, string> {
  return Object.fromEntries(
    plan.payments.map((p) => [p.accountId, formatMoney(p.closingBalance as never)]),
  );
}

describe('fundsAvailableForDebt', () => {
  /**
   * Checking $3,000.00 − cushion $1,000.00 − committed $0.00 = $2,000.00
   *
   * Rent is due on day 1. As of 2026-03-05 the 1st has passed, so the next occurrence is
   * 2026-04-01, which is after payday on 2026-03-15. Nothing is committed inside the window.
   */
  it('is the funding account less its cushion and anything due before payday', () => {
    const funds = fundsAvailableForDebt(STATE, SNAPSHOT, AS_OF);
    expect(formatMoney(funds.value)).toBe('$2,000.00');
  });

  /**
   * Savings is deliberately excluded. Total cash is $3,500.00 and total cushion $1,000.00, so a
   * pooling implementation would say $2,500.00. Moving money in from savings is the user's
   * decision, so the allocator must not assume it.
   */
  it('ignores cash sitting in other accounts', () => {
    const funds = fundsAvailableForDebt(STATE, SNAPSHOT, AS_OF);
    expect(formatMoney(funds.value)).not.toBe('$2,500.00');
  });

  /**
   * As of 2026-03-20 the next payday is 2026-04-15, and rent on 2026-04-01 falls inside it.
   * $3,000.00 − $1,000.00 cushion − $1,200.00 rent = $800.00
   */
  it('subtracts a commitment once it falls inside the window', () => {
    const funds = fundsAvailableForDebt(STATE, SNAPSHOT, '2026-03-20');
    expect(formatMoney(funds.value)).toBe('$800.00');
  });

  /** A balance below the cushion cannot produce a negative allocation budget. */
  it('clamps at zero rather than going negative', () => {
    const funds = fundsAvailableForDebt(STATE, withBalances({ [CHECKING]: '400.00' }), AS_OF);
    expect(formatMoney(funds.value)).toBe('$0.00');
  });

  it('explains every step it took', () => {
    const funds = fundsAvailableForDebt(STATE, SNAPSHOT, AS_OF);
    expect(funds.steps.length).toBeGreaterThan(0);
    expect(funds.steps.at(-1)?.substitution).toBe('$3,000.00 - $1,000.00 - $0.00');
  });
});

describe('buildPlan', () => {
  const FUNDS = parseMoney('2000.00');

  /**
   * Avalanche: highest APR first, so Card A (24%) then Card B (18%) then Loan (6%).
   *
   *   minimums reserved   A $50.00 + B $25.00 + Loan $200.00 = $275.00
   *   left to order       $2,000.00 − $275.00               = $1,725.00
   *   A takes the rest    $50.00 + $1,725.00                = $1,775.00, leaving $225.00
   *   B                   $25.00                                        leaving $775.00
   *   Loan                $200.00                                       leaving $9,800.00
   *   total               $1,775.00 + $25.00 + $200.00       = $2,000.00
   */
  it('follows the avalanche order and conserves the total exactly', () => {
    const plan = buildPlan(STATE, SNAPSHOT, FUNDS, 'avalanche');

    expect(paid(plan)).toEqual({
      [CARD_A]: '$1,775.00',
      [CARD_B]: '$25.00',
      [LOAN]: '$200.00',
    });
    expect(closing(plan)).toEqual({
      [CARD_A]: '$225.00',
      [CARD_B]: '$775.00',
      [LOAN]: '$9,800.00',
    });
    expect(formatMoney(plan.totalAllocated)).toBe('$2,000.00');
    expect(formatMoney(plan.leftOver)).toBe('$0.00');
    expect(plan.minimumsCovered).toBe(true);
  });

  /**
   * Interest next month on what remains, at APR / 12:
   *   A     $225.00 x 0.02  = $4.50
   *   B     $775.00 x 0.015 = $11.625 -> $11.63 (half away from zero)
   *   Loan  $9,800.00 x 0.005 = $49.00
   *   total                  = $65.13
   */
  it('scores the avalanche plan at $65.13 of interest next month', () => {
    const plan = buildPlan(STATE, SNAPSHOT, FUNDS, 'avalanche');
    expect(formatMoney(plan.projectedMonthlyInterest)).toBe('$65.13');
  });

  /**
   * Snowball: smallest balance first, so B ($800) then A ($2,000) then Loan ($10,000).
   *
   *   minimums            B $25.00 + A $50.00 + Loan $200.00 = $275.00
   *   left to order                                          = $1,725.00
   *   B clears            $25.00 + $775.00 = $800.00                    leaving $0.00
   *   A                   $50.00 + $950.00 = $1,000.00                  leaving $1,000.00
   *   Loan                $200.00                                       leaving $9,800.00
   *
   * Interest: B $0.00 + A ($1,000.00 x 0.02 = $20.00) + Loan $49.00 = $69.00
   */
  it('clears the smallest balance under snowball, at a higher interest cost', () => {
    const plan = buildPlan(STATE, SNAPSHOT, FUNDS, 'snowball');

    expect(paid(plan)).toEqual({
      [CARD_B]: '$800.00',
      [CARD_A]: '$1,000.00',
      [LOAN]: '$200.00',
    });
    expect(plan.accountsCleared).toBe(1);
    expect(formatMoney(plan.projectedMonthlyInterest)).toBe('$69.00');
    expect(formatMoney(plan.totalAllocated)).toBe('$2,000.00');
  });

  /**
   * Largest balance first: Loan ($10,000) then A ($2,000) then B ($800).
   *
   *   minimums            Loan $200.00 + A $50.00 + B $25.00 = $275.00
   *   Loan takes the rest $200.00 + $1,725.00 = $1,925.00              leaving $8,075.00
   *   A                   $50.00                                       leaving $1,950.00
   *   B                   $25.00                                       leaving $775.00
   *
   * Interest: Loan ($8,075.00 x 0.005 = $40.375 -> $40.38) + A ($39.00) + B ($11.63) = $91.01
   */
  it('is most expensive when chasing the largest balance', () => {
    const plan = buildPlan(STATE, SNAPSHOT, FUNDS, 'highest-balance');

    expect(paid(plan)).toEqual({
      [LOAN]: '$1,925.00',
      [CARD_A]: '$50.00',
      [CARD_B]: '$25.00',
    });
    expect(formatMoney(plan.projectedMonthlyInterest)).toBe('$91.01');
    expect(plan.accountsCleared).toBe(0);
  });

  /** Credit impact runs high, medium, low — the same order as APR here, so the same plan. */
  it('matches avalanche when impact and rate agree', () => {
    const byImpact = buildPlan(STATE, SNAPSHOT, FUNDS, 'credit-impact');
    const byRate = buildPlan(STATE, SNAPSHOT, FUNDS, 'avalanche');
    expect(paid(byImpact)).toEqual(paid(byRate));
  });

  const EVERY: readonly StrategyId[] = ['avalanche', 'snowball', 'credit-impact', 'highest-balance'];

  it.each(EVERY)('never allocates more than the funds available (%s)', (strategy) => {
    const plan = buildPlan(STATE, SNAPSHOT, FUNDS, strategy);
    expect(plan.totalAllocated).toBeLessThanOrEqual(FUNDS);
  });

  it.each(EVERY)('never pays an account into credit (%s)', (strategy) => {
    const plan = buildPlan(STATE, SNAPSHOT, FUNDS, strategy);
    for (const payment of plan.payments) {
      expect(payment.amount).toBeLessThanOrEqual(payment.openingBalance);
      expect(payment.closingBalance).toBeGreaterThanOrEqual(0);
    }
  });

  it.each(EVERY)('conserves cash exactly: allocated + leftover = funds (%s)', (strategy) => {
    const plan = buildPlan(STATE, SNAPSHOT, FUNDS, strategy);
    expect(plan.totalAllocated + plan.leftOver).toBe(FUNDS);
  });

  it.each(EVERY)('reduces debt by exactly what it allocates (%s)', (strategy) => {
    const plan = buildPlan(STATE, SNAPSHOT, FUNDS, strategy);
    const reduced = plan.payments.reduce((acc, p) => acc + (p.openingBalance - p.closingBalance), 0);
    expect(reduced).toBe(plan.totalAllocated);
  });

  /**
   * $200.00 does not cover the $275.00 of minimums. Paying in strategy order means the shortfall
   * lands on the debt the strategy ranks last, not on an arbitrary one.
   *
   *   avalanche order A, B, Loan:  A $50.00, B $25.00, Loan $125.00 of its $200.00 minimum
   */
  it('reports a shortfall and lets it fall on the least urgent debt', () => {
    const plan = buildPlan(STATE, SNAPSHOT, parseMoney('200.00'), 'avalanche');

    expect(plan.minimumsCovered).toBe(false);
    expect(formatMoney(plan.minimumsShortfall)).toBe('$75.00');
    expect(paid(plan)).toEqual({
      [CARD_A]: '$50.00',
      [CARD_B]: '$25.00',
      [LOAN]: '$125.00',
    });
  });

  /** With nothing to allocate, every payment is zero and nothing is invented. */
  it('produces an empty but valid plan when there are no funds', () => {
    const plan = buildPlan(STATE, SNAPSHOT, parseMoney('0.00'), 'avalanche');
    expect(formatMoney(plan.totalAllocated)).toBe('$0.00');
    expect(plan.payments.every((p) => p.amount === 0)).toBe(true);
  });

  /** A cleared account carries no balance, so it is not ranked at all. */
  it('ignores accounts that are already at zero', () => {
    const snapshot = withBalances({ [CARD_A]: '0.00' });
    const plan = buildPlan(STATE, snapshot, FUNDS, 'avalanche');
    expect(plan.payments.map((p) => p.accountId)).not.toContain(CARD_A);
  });

  /**
   * Funds beyond the total debt are left in cash rather than overpaid.
   * Total debt is $12,800.00; allocating $13,000.00 must leave $200.00 unallocated.
   */
  it('leaves surplus in cash rather than overpaying', () => {
    const plan = buildPlan(STATE, SNAPSHOT, parseMoney('13000.00'), 'avalanche');
    expect(formatMoney(plan.totalAllocated)).toBe('$12,800.00');
    expect(formatMoney(plan.leftOver)).toBe('$200.00');
    expect(plan.accountsCleared).toBe(3);
  });
});

describe('recommend', () => {
  it('returns the primary plus the other three, ranked by cost', () => {
    const result = recommend(STATE, SNAPSHOT, AS_OF);

    expect(result.primary.strategy.id).toBe('avalanche');
    expect(result.alternatives).toHaveLength(3);
    expect(result.alternatives.map((a) => a.strategy.id)).toEqual([
      'credit-impact',
      'snowball',
      'highest-balance',
    ]);
  });

  /** The avalanche is cheapest here, so the justification should say so outright. */
  it('justifies the primary against the cheapest alternative', () => {
    const result = recommend(STATE, SNAPSHOT, AS_OF);
    expect(result.whyPrimary).toContain('$65.13');
    expect(result.whyPrimary).toContain('least interest');
  });

  /** Choosing a costlier strategy on purpose must be reported as costing more, not hidden. */
  it('is honest when the chosen strategy is not the cheapest', () => {
    const result = recommend(STATE, SNAPSHOT, AS_OF, 'highest-balance');
    expect(result.primary.strategy.id).toBe('highest-balance');
    expect(result.whyPrimary).toContain('not on cost');
    expect(result.whyPrimary).toContain('$25.88');
  });

  it('states its assumptions', () => {
    const result = recommend(STATE, SNAPSHOT, AS_OF);
    expect(result.assumptions.join(' ')).toContain('Nothing is executed by this tool');
  });
});
