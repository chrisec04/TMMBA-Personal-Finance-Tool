/**
 * The cross-check.
 *
 * This is the safeguard the whole architecture rests on. Claude may quote a figure in its
 * commentary; that figure is compared, to the cent, against what the engine computed. Three
 * things follow, and the order matters:
 *
 *   1. the engine's value always wins;
 *   2. a disagreement is **shown to the user**, not silently corrected;
 *   3. the commentary is still displayed, clearly marked, rather than discarded.
 *
 * Point 2 is the one that is easy to get wrong. Quietly replacing a wrong number with the right
 * one produces a tool that looks perfect and hides the fact that its narrative and its arithmetic
 * disagreed — which is precisely the failure the brief asks to be made visible. A user who sees
 * "the write-up said $1,700.00, the calculation says $1,775.00" learns something true about how
 * much to trust the paragraph next to it.
 */

import { formatMoney, parseMoney, type Cents } from '../domain/money.ts';
import type { AllocationPlan } from '../domain/allocation.ts';
import type { Analysis, DebtNote } from './schema.ts';

export interface Discrepancy {
  readonly accountId: string;
  readonly accountName: string;
  /** What Claude wrote. */
  readonly claimed: string;
  /** What the engine computed, which is what the tool displays. */
  readonly actual: string;
  readonly difference: string;
}

export interface CheckedAnalysis {
  readonly analysis: Analysis;
  /** Every figure Claude quoted that did not match. Empty is the expected case. */
  readonly discrepancies: readonly Discrepancy[];
  /** True when every quoted figure matched the engine. */
  readonly trustworthy: boolean;
  /** Notes whose accounts exist in the plan, in the plan's own ranking order. */
  readonly notesInPlanOrder: readonly DebtNote[];
  readonly caveat: string | null;
}

/** Parses a figure Claude quoted. An unparseable one is a discrepancy, not a crash. */
function tryParse(value: string): Cents | null {
  try {
    return parseMoney(value);
  } catch {
    return null;
  }
}

/**
 * Compares every quoted figure with the engine's own, and orders the notes to match the plan.
 *
 * Reordering matters as much as checking: a model asked to comment on a ranked list will
 * occasionally return the entries in a different order, and a reader comparing the narrative to
 * the payment table would take that as disagreement about priority when it is not.
 */
export function crossCheck(analysis: Analysis, plan: AllocationPlan): CheckedAnalysis {
  const byAccount = new Map(plan.payments.map((payment) => [payment.accountId, payment]));
  const discrepancies: Discrepancy[] = [];

  for (const note of analysis.debtNotes) {
    if (note.citedPayment === undefined) continue;

    const payment = byAccount.get(note.accountId as never);
    if (payment === undefined) continue;

    const claimed = tryParse(note.citedPayment);
    if (claimed === null) {
      discrepancies.push({
        accountId: note.accountId,
        accountName: payment.accountName,
        claimed: note.citedPayment,
        actual: formatMoney(payment.amount),
        difference: 'not a readable amount',
      });
      continue;
    }

    if (claimed !== payment.amount) {
      discrepancies.push({
        accountId: note.accountId,
        accountName: payment.accountName,
        claimed: formatMoney(claimed),
        actual: formatMoney(payment.amount),
        difference: formatMoney((payment.amount - claimed) as Cents, { signed: true }),
      });
    }
  }

  const order = new Map(plan.payments.map((payment, index) => [payment.accountId as string, index]));
  const notesInPlanOrder = [...analysis.debtNotes]
    .filter((note) => order.has(note.accountId))
    .sort((a, b) => (order.get(a.accountId) ?? 0) - (order.get(b.accountId) ?? 0));

  const trustworthy = discrepancies.length === 0;

  const caveat = trustworthy
    ? null
    : `The written commentary quoted ${discrepancies.length} figure(s) that do not match the calculation. The figures shown in the plan are the calculated ones and are correct; treat the wording below with caution.`;

  return { analysis, discrepancies, trustworthy, notesInPlanOrder, caveat };
}

/**
 * Sanity-checks the commentary for numbers that were never supplied to it.
 *
 * A weaker guard than {@link crossCheck}, and intentionally advisory: it scans free text for
 * currency amounts and reports any that do not appear anywhere in the plan. Prose legitimately
 * mentions amounts, so this informs rather than blocks — but a paragraph full of figures the
 * engine never computed is worth surfacing.
 */
export function unexplainedFigures(analysis: Analysis, plan: AllocationPlan): readonly string[] {
  const known = new Set<string>();
  for (const payment of plan.payments) {
    known.add(formatMoney(payment.amount));
    known.add(formatMoney(payment.openingBalance));
    known.add(formatMoney(payment.closingBalance));
  }
  known.add(formatMoney(plan.totalAllocated));
  known.add(formatMoney(plan.leftOver));
  known.add(formatMoney(plan.fundsAvailable));
  known.add(formatMoney(plan.projectedMonthlyInterest));
  known.add(formatMoney(plan.totalDebtAfter));

  const prose = [
    analysis.summary,
    ...analysis.tradeoffs,
    ...analysis.watchOuts,
    ...analysis.debtNotes.map((note) => note.note),
  ].join(' ');

  const found = prose.match(/\$[\d,]+(?:\.\d{2})?/g) ?? [];
  return [...new Set(found)].filter((figure) => !known.has(figure));
}
