/**
 * End-to-end smoke test.
 *
 * Walks the exact path the app takes when it opens: build the demo dataset for today, read the
 * position, ask an affordability question, generate a recommendation, validate it, and run the
 * commentary pass through the keyless transport.
 *
 * A typecheck proves these functions fit together. This proves they actually run — against a
 * realistic eight-month dataset rather than the tidy fixtures, and on today's date rather than a
 * frozen one, so a date-handling bug that only appears in certain months has somewhere to show
 * up. It needs no API key and no network, which is what lets it run in CI on a fresh clone.
 */

import { describe, expect, it } from 'vitest';
import { buildDemoState } from './seed/demoData.ts';
import { latestSnapshot } from './domain/accounts.ts';
import { todayIso, type IsoDate } from './domain/dates.ts';
import { assessHealth } from './domain/health.ts';
import { checkAffordability } from './domain/affordability.ts';
import { recommend, type StrategyId } from './domain/allocation.ts';
import { proposalFromPlan, validate } from './domain/validation.ts';
import { parseMoney } from './domain/money.ts';
import { analyse, recordedTransport } from './claude/analysis.ts';
import { DEFAULT_MODEL } from './claude/ClaudePort.ts';

/** Several dates, so month-length and payday edge cases are all exercised. */
const DATES: readonly IsoDate[] = [
  todayIso(),
  '2026-01-31',
  '2026-02-28',
  '2024-02-29',
  '2026-04-01',
  '2026-04-15',
  '2026-12-31',
];

const STRATEGIES: readonly StrategyId[] = [
  'avalanche',
  'snowball',
  'credit-impact',
  'highest-balance',
];

describe('the app flow on a fresh open', () => {
  it.each(DATES)('works end to end as of %s', (asOf) => {
    const state = buildDemoState(asOf);
    const snapshot = latestSnapshot(state.history);
    expect(snapshot).toBeDefined();
    if (snapshot === undefined) return;

    // Snapshot surface.
    const health = assessHealth(state, snapshot, asOf);
    expect(['good', 'moderate', 'at-risk']).toContain(health.overall);
    expect(health.accounts.length).toBeGreaterThan(0);
    expect(health.assumptions.length).toBeGreaterThan(0);

    // Affordability surface.
    const answer = checkAffordability(state, snapshot, {
      amount: parseMoney('250.00'),
      asOf,
      description: 'a new pair of boots',
    });
    expect(typeof answer.affordable).toBe('boolean');
    expect(answer.reasoning.length).toBeGreaterThan(20);
    expect(answer.explanation.steps.length).toBeGreaterThan(0);

    // Recommendation surface, every strategy.
    for (const strategy of STRATEGIES) {
      const recommendation = recommend(state, snapshot, asOf, strategy);
      expect(recommendation.alternatives).toHaveLength(3);
      expect(recommendation.whyPrimary.length).toBeGreaterThan(20);

      // Money is conserved no matter the date or the ordering.
      const plan = recommendation.primary;
      expect(plan.totalAllocated + plan.leftOver).toBe(recommendation.fundsAvailable.value);

      // Validation surface: every rule reports, and any failure carries a way out.
      const report = validate(
        state,
        snapshot,
        proposalFromPlan(plan, state.primaryCashAccountId, asOf),
      );
      expect(report.results).toHaveLength(10);
      for (const rule of report.results) {
        if (!rule.passed) expect(rule.remedy).toBeDefined();
      }
    }
  });

  /**
   * The demo has to actually demonstrate something.
   *
   * An earlier version left the checking balance too low to cover a full month of commitments
   * plus the cushion, so funds available came out at zero and the flagship screen showed four
   * identical empty plans. That is arithmetically correct and completely useless as a demo, and
   * nothing else in the suite noticed. This is the guard.
   */
  it('gives the demo a meaningful plan to show, not an empty one', () => {
    const asOf = todayIso();
    const state = buildDemoState(asOf);
    const snapshot = latestSnapshot(state.history);
    if (snapshot === undefined) throw new Error('demo data has no snapshots');

    const recommendation = recommend(state, snapshot, asOf);
    const plan = recommendation.primary;

    expect(recommendation.fundsAvailable.value).toBeGreaterThan(0);
    expect(plan.totalAllocated).toBeGreaterThan(0);
    expect(plan.minimumsCovered).toBe(true);
    // At least one account should be cleared outright, so the "clears account" marker is
    // exercised, and at least one should be partially paid, so the ordering visibly matters.
    expect(plan.accountsCleared).toBeGreaterThanOrEqual(1);
    expect(plan.payments.some((p) => p.extraPortion > 0 && !p.clearsAccount)).toBe(true);

    // The four strategies must not all produce the same answer, or the comparison table teaches
    // nothing.
    const scores = new Set(
      [plan, ...recommendation.alternatives].map((p) => p.projectedMonthlyInterest),
    );
    expect(scores.size).toBeGreaterThan(1);

    // And the plan the demo opens on must pass validation, so the first impression is a green
    // Validation screen rather than a wall of rejections.
    const report = validate(
      state,
      snapshot,
      proposalFromPlan(plan, state.primaryCashAccountId, asOf),
    );
    expect(report.approved, report.combination).toBe(true);
  });

  /**
   * The keyless path is the one an evaluator sees first, so it has to survive the whole
   * pipeline: recorded reply, JSON extraction, schema validation and cross-check.
   */
  it('produces trustworthy commentary with no API key', async () => {
    const asOf = todayIso();
    const state = buildDemoState(asOf);
    const snapshot = latestSnapshot(state.history);
    if (snapshot === undefined) throw new Error('demo data has no snapshots');

    const recommendation = recommend(state, snapshot, asOf);
    const health = assessHealth(state, snapshot, asOf);

    const outcome = await analyse(recordedTransport(() => recommendation), {
      recommendation,
      health,
      model: DEFAULT_MODEL,
    });

    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;

    expect(outcome.fromRecording).toBe(true);
    // The recorded reply must agree with the arithmetic it was generated from, or the keyless
    // demo would open on a discrepancy warning and teach the wrong lesson about the tool.
    expect(outcome.checked.trustworthy).toBe(true);
    expect(outcome.checked.discrepancies).toEqual([]);
    expect(outcome.unexplained).toEqual([]);
    expect(outcome.checked.analysis.summary.length).toBeGreaterThan(50);
  });

  /** A failure in the commentary must never take the arithmetic down with it. */
  it('still returns a usable outcome when the transport fails', async () => {
    const asOf = todayIso();
    const state = buildDemoState(asOf);
    const snapshot = latestSnapshot(state.history);
    if (snapshot === undefined) throw new Error('demo data has no snapshots');

    const recommendation = recommend(state, snapshot, asOf);

    const broken = {
      keyStatus: () => Promise.reject(new Error('nope')),
      setKey: () => Promise.reject(new Error('nope')),
      clearKey: () => Promise.reject(new Error('nope')),
      verifyConnection: () => Promise.reject(new Error('nope')),
      listModels: () => Promise.reject(new Error('nope')),
      send: () => Promise.reject(new Error('the network is on fire')),
    };

    const outcome = await analyse(broken, {
      recommendation,
      health: null,
      model: DEFAULT_MODEL,
    });

    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.reason).toContain('the network is on fire');
    expect(outcome.remedy).toContain('unaffected');
  });
});
