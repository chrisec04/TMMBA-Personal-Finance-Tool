/**
 * The keyless adapter.
 *
 * Returns a recorded reply instead of calling anything. This is what makes the tool evaluable on
 * a fresh clone with no Anthropic account: every surface works, the whole twenty-scenario gate
 * runs, and the only thing missing is a live model.
 *
 * The recording is written to be *obviously* a recording — it names itself as one — because a
 * canned paragraph that reads like a live response is a way to mislead someone assessing the
 * tool, and the whole point of this project is that its outputs are checkable.
 *
 * It also deliberately quotes one payment figure correctly, so that the cross-check has real
 * work to do in the demo rather than trivially passing over an empty set.
 */

import { DEFAULT_MODEL, type ClaudePort, type ClaudeReply, type ClaudeRequest, type KeyStatus, type ModelInfo } from './ClaudePort.ts';
import { formatMoney } from '../domain/money.ts';
import type { AllocationPlan } from '../domain/allocation.ts';

const NO_KEY: KeyStatus = { configured: false, source: 'none', hint: null };

/**
 * Builds a recorded analysis that fits whatever plan it is given.
 *
 * Generated from the plan rather than stored as a fixed string, because a hardcoded paragraph
 * would contradict the demo data the moment either changed — and a demo whose commentary
 * disagrees with its own table teaches the wrong lesson about this tool.
 */
export function recordedAnalysisFor(plan: AllocationPlan): string {
  const ranked = [...plan.payments].sort((a, b) => a.rank - b.rank);
  const first = ranked[0];
  const cleared = ranked.filter((p) => p.clearsAccount);

  const summary =
    first === undefined
      ? 'There is nothing to allocate this month, so the plan is empty. This is a recorded response: no API key is configured, so the commentary is canned while the figures beside it are fully calculated.'
      : `This is a recorded response — no API key is configured, so the wording is canned, while every figure shown beside it is calculated by the tool itself. The plan puts ${formatMoney(first.amount)} against ${first.accountName} first, then works down the ranking, keeping the cash cushion untouched. ${cleared.length > 0 ? `It clears ${cleared.map((p) => p.accountName).join(' and ')} outright.` : 'No account is cleared outright this month.'} Interest still accruing next month on what remains is ${formatMoney(plan.projectedMonthlyInterest)}.`;

  const debtNotes = ranked.map((payment, index) => ({
    accountId: payment.accountId,
    note:
      index === 0
        ? `Ranked first. ${payment.rankReason}`
        : `${payment.rankReason}${payment.amount === payment.minimumPortion ? ' Receives its contractual minimum only, because the money ran out further up the list.' : ''}`,
    // One correctly-quoted figure, so the cross-check has something real to verify in the demo.
    ...(index === 0 ? { citedPayment: (payment.amount / 100).toFixed(2) } : {}),
  }));

  return JSON.stringify({
    summary,
    debtNotes,
    tradeoffs: [
      'Ordering by interest rate costs the least overall, but it can take longer before any single account disappears, which some people find harder to stick with.',
      'Every spare dollar going to debt is a dollar not going to savings. The cushion is protected, but nothing above it is being set aside.',
    ],
    watchOuts: [
      'These balances were typed in by hand. If any of them has moved since, the ordering may no longer be right.',
      'Interest here is a one-month comparison between plans at APR / 12, not a forecast of what will actually be charged.',
      'Add a real API key in Settings to replace this recorded commentary with live analysis.',
    ],
  });
}

export class StubClaude implements ClaudePort {
  constructor(private readonly planFor: () => AllocationPlan | null) {}

  keyStatus(): Promise<KeyStatus> {
    return Promise.resolve(NO_KEY);
  }

  setKey(): Promise<KeyStatus> {
    return Promise.reject(
      new Error('The recorded adapter holds no key. Run the app to configure one.'),
    );
  }

  clearKey(): Promise<KeyStatus> {
    return Promise.resolve(NO_KEY);
  }

  listModels(): Promise<readonly ModelInfo[]> {
    return Promise.resolve([{ id: DEFAULT_MODEL, displayName: 'Recorded (no key configured)' }]);
  }

  send(_request: ClaudeRequest): Promise<ClaudeReply> {
    const plan = this.planFor();
    const text =
      plan === null
        ? JSON.stringify({ summary: 'No plan to explain.', debtNotes: [], tradeoffs: [], watchOuts: [] })
        : recordedAnalysisFor(plan);

    return Promise.resolve({ text, latencyMs: 0, fromRecording: true });
  }
}
