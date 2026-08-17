/**
 * The deployment gate.
 *
 * Runs all twenty scenarios and checks every intermediate and final value against the figures
 * worked out by hand in `scenarios.ts`. The brief's bar is 100%: if any calculation fails, the
 * tool is not deployment-ready, so this suite has no allowance for a partial pass.
 *
 * It runs with **no API key and no network access**, because none of the arithmetic goes near
 * Claude. That is a deliberate property: the number-producing part of this tool is testable in
 * CI, on a fresh clone, by someone who has never held an Anthropic credential.
 */

import { describe, expect, it } from 'vitest';
import { formatMoney, parseMoney } from '../src/domain/money.ts';
import type { AccountId } from '../src/domain/accounts.ts';
import { buildPlan, fundsAvailableForDebt } from '../src/domain/allocation.ts';
import { proposalFromPlan, validate, type Proposal } from '../src/domain/validation.ts';
import { SCENARIOS, type Scenario } from './scenarios.ts';

const CHK = 'chk' as AccountId;

interface Outcome {
  readonly fundsAvailable: string;
  readonly payments: Record<string, string>;
  readonly totalAllocated: string;
  readonly leftOver: string;
  readonly closing: Record<string, string>;
  readonly minimumsCovered: boolean;
  readonly accountsCleared: number;
  readonly monthlyInterest: string;
  readonly approved: boolean;
  readonly failedRules: readonly string[];
}

function run(scenario: Scenario): Outcome {
  const funds = fundsAvailableForDebt(scenario.state, scenario.snapshot, scenario.asOf, CHK);
  const plan = buildPlan(scenario.state, scenario.snapshot, funds.value, scenario.strategy);

  const proposal: Proposal =
    scenario.manualPayments === undefined
      ? proposalFromPlan(plan, CHK, scenario.asOf)
      : {
          payments: Object.entries(scenario.manualPayments).map(([accountId, amount]) => ({
            accountId: accountId as AccountId,
            amount: parseMoney(amount),
          })),
          fundedFrom: CHK,
          asOf: scenario.asOf,
        };

  const report = validate(scenario.state, scenario.snapshot, proposal);

  return {
    fundsAvailable: formatMoney(funds.value),
    payments: Object.fromEntries(plan.payments.map((p) => [p.accountId, formatMoney(p.amount)])),
    totalAllocated: formatMoney(plan.totalAllocated),
    leftOver: formatMoney(plan.leftOver),
    closing: Object.fromEntries(
      plan.payments.map((p) => [p.accountId, formatMoney(p.closingBalance)]),
    ),
    minimumsCovered: plan.minimumsCovered,
    accountsCleared: plan.accountsCleared,
    monthlyInterest: formatMoney(plan.projectedMonthlyInterest),
    approved: report.approved,
    failedRules: report.failed,
  };
}

describe('the twenty scenarios', () => {
  it('has exactly twenty, with unique ids', () => {
    expect(SCENARIOS).toHaveLength(20);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(20);
  });

  describe.each(SCENARIOS.map((s) => [s.id, s] as const))('%s', (_id, scenario) => {
    const outcome = run(scenario);
    const want = scenario.expect;

    it('computes the funds available', () => {
      expect(outcome.fundsAvailable).toBe(want.fundsAvailable);
    });

    it('allocates the expected payment to each account', () => {
      expect(outcome.payments).toEqual(want.payments);
    });

    it('totals and leftover match', () => {
      expect(outcome.totalAllocated).toBe(want.totalAllocated);
      expect(outcome.leftOver).toBe(want.leftOver);
    });

    it('leaves the expected closing balances', () => {
      expect(outcome.closing).toEqual(want.closing);
    });

    it('reports minimum coverage and payoffs correctly', () => {
      expect(outcome.minimumsCovered).toBe(want.minimumsCovered);
      expect(outcome.accountsCleared).toBe(want.accountsCleared);
    });

    it('scores the interest left accruing', () => {
      expect(outcome.monthlyInterest).toBe(want.monthlyInterest);
    });

    it('reaches the expected validation verdict', () => {
      expect(outcome.approved).toBe(want.approved);
      expect([...outcome.failedRules].sort()).toEqual([...(want.failedRules ?? [])].sort());
    });
  });
});

/**
 * Invariants that must hold in every scenario regardless of its expected figures.
 *
 * The per-scenario assertions above check that the answers are the right ones. These check that
 * no answer, right or wrong, could ever have violated the laws the engine is built on.
 */
describe('invariants across all twenty', () => {
  it.each(SCENARIOS.map((s) => [s.id, s] as const))(
    '%s conserves money and never overpays',
    (_id, scenario) => {
      const funds = fundsAvailableForDebt(scenario.state, scenario.snapshot, scenario.asOf, CHK);
      const plan = buildPlan(scenario.state, scenario.snapshot, funds.value, scenario.strategy);

      // Nothing invented, nothing lost.
      expect(plan.totalAllocated + plan.leftOver).toBe(funds.value);

      // Debt retired equals cash spent, to the cent.
      const retired = plan.payments.reduce(
        (acc, p) => acc + (p.openingBalance - p.closingBalance),
        0,
      );
      expect(retired).toBe(plan.totalAllocated);

      for (const payment of plan.payments) {
        expect(payment.amount).toBeGreaterThanOrEqual(0);
        expect(payment.closingBalance).toBeGreaterThanOrEqual(0);
        expect(payment.minimumPortion + payment.extraPortion).toBe(payment.amount);
      }
    },
  );

  it.each(SCENARIOS.map((s) => [s.id, s] as const))(
    '%s shows its working for every figure',
    (_id, scenario) => {
      const funds = fundsAvailableForDebt(scenario.state, scenario.snapshot, scenario.asOf, CHK);
      const plan = buildPlan(scenario.state, scenario.snapshot, funds.value, scenario.strategy);

      expect(funds.steps.length).toBeGreaterThan(0);
      expect(plan.explanation.steps.length).toBeGreaterThan(0);
      for (const step of [...funds.steps, ...plan.explanation.steps]) {
        expect(step.label).not.toBe('');
        expect(step.result).not.toBe('');
      }
    },
  );

  it.each(SCENARIOS.map((s) => [s.id, s] as const))(
    '%s is deterministic when run twice',
    (_id, scenario) => {
      expect(run(scenario)).toEqual(run(scenario));
    },
  );
});
