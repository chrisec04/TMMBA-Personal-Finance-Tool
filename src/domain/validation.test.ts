/**
 * Validation tests.
 *
 * Two things are asserted throughout, beyond the pass/fail itself.
 *
 * Every failure must carry a **remedy**, because failures here are hard stops with no override,
 * and a hard stop that cannot say what to change is a dead end. That is checked generically at
 * the bottom, so a future rule cannot be added without one.
 *
 * The rules are also checked against hand-edited proposals, not just generated ones — the brief
 * lets the user modify a plan before approving it, so validation has to stand on its own rather
 * than trusting the allocator.
 */

import { describe, expect, it } from 'vitest';
import { parseMoney } from './money.ts';
import {
  CARD_A,
  CARD_B,
  CHECKING,
  LOAN,
  SAVINGS,
  STATE,
  SNAPSHOT,
  withBalances,
  withoutBalances,
} from './__fixtures__/state.ts';
import { buildPlan } from './allocation.ts';
import { RULE_CODES, proposalFromPlan, validate, type Proposal } from './validation.ts';

const AS_OF = '2026-03-05';
const FUNDS = parseMoney('2000.00');

/** The approved-by-construction plan: A $1,775.00, B $25.00, Loan $200.00. */
function goodProposal(): Proposal {
  const plan = buildPlan(STATE, SNAPSHOT, FUNDS, 'avalanche');
  return proposalFromPlan(plan, CHECKING, AS_OF);
}

function edited(payments: Record<string, string>): Proposal {
  return {
    payments: Object.entries(payments).map(([accountId, amount]) => ({
      accountId: accountId as never,
      amount: parseMoney(amount),
    })),
    fundedFrom: CHECKING,
    asOf: AS_OF,
  };
}

function failedCodes(report: ReturnType<typeof validate>): readonly string[] {
  return report.failed;
}

describe('validate', () => {
  it('approves the plan the allocator produced', () => {
    const report = validate(STATE, SNAPSHOT, goodProposal());

    expect(report.approved).toBe(true);
    expect(report.failed).toEqual([]);
    expect(report.results).toHaveLength(10);
    expect(report.results.every((r) => r.passed)).toBe(true);
    expect(report.combination).toContain('All 10 rules passed');
  });

  it('shows every rule as a question with its own verdict', () => {
    const report = validate(STATE, SNAPSHOT, goodProposal());
    for (const result of report.results) {
      expect(result.question.endsWith('?')).toBe(true);
      expect(result.detail.length).toBeGreaterThan(0);
    }
  });

  /**
   * $2,100.00 against $2,000.00 available breaks two rules at once: it exceeds the funds, and it
   * leaves checking at $900.00, below the $1,000.00 cushion. Both must be reported, not just the
   * first — the brief asks for the full table.
   */
  it('reports every broken rule, not just the first', () => {
    const report = validate(
      STATE,
      SNAPSHOT,
      edited({ [CARD_A]: '1875.00', [CARD_B]: '25.00', [LOAN]: '200.00' }),
    );

    expect(report.approved).toBe(false);
    expect(failedCodes(report)).toContain(RULE_CODES.withinAvailableFunds);
    expect(failedCodes(report)).toContain(RULE_CODES.cushionMaintained);
    expect(report.combination).toContain('8 of 10 rules passed');
    expect(report.combination).toContain('cannot be overridden');
  });

  /** Paying more than is owed would push the card into credit. */
  it('rejects an overpayment and names the amount owed', () => {
    const report = validate(
      STATE,
      SNAPSHOT,
      edited({ [CARD_A]: '2500.00', [CARD_B]: '25.00', [LOAN]: '200.00' }),
    );

    const rule = report.results.find((r) => r.code === RULE_CODES.noOverpayment);
    expect(rule?.passed).toBe(false);
    expect(rule?.detail).toContain('$2,000.00 owed');
    expect(rule?.remedy).toContain('Reduce Card A to $2,000.00');
  });

  /** A blank balance is not a zero, and no rule may proceed as though it were. */
  it('rejects a plan touching an account with no recorded balance', () => {
    const report = validate(STATE, withoutBalances([CARD_B]), goodProposal());

    const rule = report.results.find((r) => r.code === RULE_CODES.balancesRecorded);
    expect(rule?.passed).toBe(false);
    expect(rule?.detail).toContain('A blank is not a zero');
    expect(rule?.remedy).toContain('Enter a balance for Card B');
  });

  it('rejects a negative payment', () => {
    const report = validate(
      STATE,
      SNAPSHOT,
      edited({ [CARD_A]: '-100.00', [CARD_B]: '25.00', [LOAN]: '200.00' }),
    );
    expect(failedCodes(report)).toContain(RULE_CODES.paymentsNonNegative);
  });

  it('rejects a payment aimed at a cash account', () => {
    const report = validate(STATE, SNAPSHOT, edited({ [SAVINGS]: '100.00' }));

    const rule = report.results.find((r) => r.code === RULE_CODES.paymentsToLiabilities);
    expect(rule?.passed).toBe(false);
    expect(rule?.remedy).toContain('transfer, not a debt payment');
  });

  /**
   * Dropping the loan payment entirely still satisfies the funds rule, but misses a $200.00
   * contractual minimum. This is the case a naive "does it fit in the budget" check would pass.
   */
  it('rejects a plan that skips a contractual minimum', () => {
    const report = validate(STATE, SNAPSHOT, edited({ [CARD_A]: '1775.00', [CARD_B]: '25.00' }));

    const rule = report.results.find((r) => r.code === RULE_CODES.minimumsCovered);
    expect(rule?.passed).toBe(false);
    expect(rule?.detail).toContain('$200.00 minimum');
    expect(rule?.remedy).toContain('Raise Loan to $200.00');
    expect(rule?.remedy).toContain('credit damage');
  });

  /**
   * As of 2026-03-20, rent of $1,200.00 sits before the next payday. Spending $2,000.00 leaves
   * $1,000.00, which cannot cover it.
   */
  it('rejects a plan that would leave rent unpayable', () => {
    const proposal: Proposal = { ...goodProposal(), asOf: '2026-03-20' };
    const report = validate(STATE, SNAPSHOT, proposal);

    const rule = report.results.find((r) => r.code === RULE_CODES.commitmentsCovered);
    expect(rule?.passed).toBe(false);
    expect(rule?.detail).toContain('Rent');
    expect(rule?.remedy).toContain('still clear');
  });

  it('rejects a plan that would overdraw the funding account', () => {
    const report = validate(
      STATE,
      withBalances({ [CHECKING]: '100.00' }),
      edited({ [CARD_A]: '500.00' }),
    );

    expect(failedCodes(report)).toContain(RULE_CODES.cashNotNegative);
    const rule = report.results.find((r) => r.code === RULE_CODES.cashNotNegative);
    expect(rule?.remedy).toContain('overdrawn by');
  });

  /** Conservation is a check on the tool itself, so it should hold for every generated plan. */
  it('always balances the money for a generated plan', () => {
    for (const strategy of ['avalanche', 'snowball', 'credit-impact', 'highest-balance'] as const) {
      const plan = buildPlan(STATE, SNAPSHOT, FUNDS, strategy);
      const report = validate(STATE, SNAPSHOT, proposalFromPlan(plan, CHECKING, AS_OF));
      const rule = report.results.find((r) => r.code === RULE_CODES.conservation);
      expect(rule?.passed, `${strategy} broke conservation`).toBe(true);
    }
  });

  /**
   * The remedy is the escape hatch from a hard stop. A failing rule without one would leave the
   * user stuck, so this is asserted across every failure mode rather than case by case.
   */
  it('always offers a specific remedy on a failure', () => {
    const broken: readonly Proposal[] = [
      edited({ [CARD_A]: '5000.00' }),
      edited({ [CARD_A]: '-5.00' }),
      edited({ [SAVINGS]: '10.00' }),
      edited({}),
      { ...goodProposal(), asOf: '2026-03-20' },
    ];

    for (const proposal of broken) {
      const report = validate(STATE, SNAPSHOT, proposal);
      for (const result of report.results) {
        if (result.passed) continue;
        expect(result.remedy, `${result.code} failed without a remedy`).toBeDefined();
        expect(result.remedy?.length ?? 0).toBeGreaterThan(20);
      }
    }
  });

  /** There is no override API. Approval is a pure function of the rules, and cannot be forced. */
  it('approves only when every rule passes', () => {
    const report = validate(STATE, SNAPSHOT, edited({ [CARD_A]: '5000.00' }));
    expect(report.approved).toBe(report.results.every((r) => r.passed));
    expect(report.approved).toBe(false);
  });
});
