/**
 * Health tests.
 *
 * The bands are the interesting part: "moderate" exists so that a balance sitting just above its
 * cushion does not read as identical to one sitting comfortably clear of it.
 */

import { describe, expect, it } from 'vitest';
import { formatMoney } from './money.ts';
import { CHECKING, SAVINGS, STATE, SNAPSHOT, withBalances, withoutBalances } from './__fixtures__/state.ts';
import { STALE_AFTER_DAYS, assessHealth } from './health.ts';

const SAME_DAY = '2026-03-05';

function statusOf(report: ReturnType<typeof assessHealth>, id: string): string {
  return report.accounts.find((a) => a.account.id === id)?.status ?? 'missing';
}

describe('assessHealth', () => {
  /**
   * checking $3,000.00 − $1,000.00 cushion = $2,000.00 headroom, band $500.00 -> good
   * savings    $500.00 −     $0.00 cushion =   $500.00 headroom, band   $0.00 -> good
   * total cash                             = $3,500.00
   */
  it('reads a comfortable position as good', () => {
    const report = assessHealth(STATE, SNAPSHOT, SAME_DAY);

    expect(report.overall).toBe('good');
    expect(statusOf(report, CHECKING)).toBe('good');
    expect(statusOf(report, SAVINGS)).toBe('good');
    expect(formatMoney(report.totalCash.value)).toBe('$3,500.00');
    expect(formatMoney(report.totalCushion)).toBe('$1,000.00');
  });

  /** $900.00 − $1,000.00 = −$100.00 headroom. Below the cushion is at-risk, full stop. */
  it('reads a breached cushion as at-risk', () => {
    const report = assessHealth(STATE, withBalances({ [CHECKING]: '900.00' }), SAME_DAY);

    expect(statusOf(report, CHECKING)).toBe('at-risk');
    expect(report.overall).toBe('at-risk');
    const checking = report.accounts.find((a) => a.account.id === CHECKING);
    expect(formatMoney(checking?.headroom ?? 0 as never)).toBe('-$100.00');
  });

  /**
   * The moderate band is half the cushion again: $500.00 here.
   * $1,400.00 leaves $400.00 of headroom, inside the band -> moderate.
   * $1,500.00 leaves $500.00, which is the band exactly, and the band is exclusive -> good.
   */
  it('distinguishes a thin margin from a comfortable one', () => {
    const thin = assessHealth(STATE, withBalances({ [CHECKING]: '1400.00' }), SAME_DAY);
    expect(statusOf(thin, CHECKING)).toBe('moderate');

    const exactlyAtBand = assessHealth(STATE, withBalances({ [CHECKING]: '1500.00' }), SAME_DAY);
    expect(statusOf(exactlyAtBand, CHECKING)).toBe('good');
  });

  /** Sitting exactly on the cushion is not yet a breach. */
  it('treats sitting exactly on the cushion as moderate, not at-risk', () => {
    const report = assessHealth(STATE, withBalances({ [CHECKING]: '1000.00' }), SAME_DAY);
    expect(statusOf(report, CHECKING)).toBe('moderate');
  });

  /** One bad account is enough: the overall reading is the worst of them, never an average. */
  it('takes the worst account as the overall status', () => {
    const report = assessHealth(
      STATE,
      withBalances({ [CHECKING]: '5000.00', [SAVINGS]: '-1.00' }),
      SAME_DAY,
    );

    expect(statusOf(report, CHECKING)).toBe('good');
    expect(statusOf(report, SAVINGS)).toBe('at-risk');
    expect(report.overall).toBe('at-risk');
  });

  it('reports how old the balances are', () => {
    const fresh = assessHealth(STATE, SNAPSHOT, SAME_DAY);
    expect(fresh.daysSinceSnapshot).toBe(0);
    expect(fresh.stale).toBe(false);

    const old = assessHealth(STATE, SNAPSHOT, '2026-03-25');
    expect(old.daysSinceSnapshot).toBe(20);
    expect(old.stale).toBe(true);
    expect(old.assumptions.join(' ')).toContain(`more than ${STALE_AFTER_DAYS} days old`);
  });

  /** Exactly at the threshold is not yet stale; one day past it is. */
  it('is precise about the staleness boundary', () => {
    expect(assessHealth(STATE, SNAPSHOT, '2026-03-19').stale).toBe(false);
    expect(assessHealth(STATE, SNAPSHOT, '2026-03-20').stale).toBe(true);
  });

  /** A blank is not a zero, so the assumption it forced has to be stated. */
  it('flags an account it had to assume a balance for', () => {
    const report = assessHealth(STATE, withoutBalances([SAVINGS]), SAME_DAY);
    expect(report.assumptions.join(' ')).toContain('No balance was recorded for Savings');
    expect(report.assumptions.join(' ')).toContain('understate your position');
  });

  it('always states that nothing was fetched from a bank', () => {
    const report = assessHealth(STATE, SNAPSHOT, SAME_DAY);
    expect(report.assumptions.join(' ')).toContain('nothing is retrieved from a bank');
  });

  it('explains each account with visible math', () => {
    const report = assessHealth(STATE, SNAPSHOT, SAME_DAY);
    const checking = report.accounts.find((a) => a.account.id === CHECKING);
    const substitutions = checking?.explanation.steps.map((s) => s.substitution) ?? [];
    expect(substitutions).toContain('$3,000.00 - $1,000.00');
  });
});
