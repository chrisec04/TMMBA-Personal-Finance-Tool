/**
 * Prompt construction.
 *
 * The plan is already decided before this file runs. Claude is handed the finished arithmetic
 * and asked to explain it, which is a much narrower job than "work out what to pay" and a much
 * easier one to be right about.
 *
 * The prompt therefore does two things carefully: it supplies every figure the commentary could
 * need, so there is no reason to estimate one; and it says plainly that the figures are settled,
 * so there is no invitation to recompute them.
 */

import { formatMoney } from '../domain/money.ts';
import type { Recommendation } from '../domain/allocation.ts';
import type { HealthReport } from '../domain/health.ts';
import { RESPONSE_SHAPE } from './schema.ts';
import type { ClaudeRequest } from './ClaudePort.ts';

export const SYSTEM_PROMPT = `You are the explanatory layer of a personal finance tool. The user is deciding how to split a fixed amount of money across their debts this month.

The tool has ALREADY calculated the plan. Your job is to explain the reasoning, name the tradeoffs, and flag what to watch. You are not being asked to compute anything.

Rules, in order of importance:

1. NEVER calculate, estimate, adjust or infer a monetary figure. Every number you need is given to you. If a number you want is not in the input, say so in plain words instead of producing one.
2. If you quote a payment amount, put it in the "citedPayment" field of that debt's note, exactly as it was given to you. It will be checked against the calculation, and a mismatch is shown to the user.
3. Do not recommend a different plan. If you think the ordering is wrong, say why in "tradeoffs" and let the user decide.
4. Do not offer behavioural or emotional coaching. Explain the money.
5. If the information given is not enough to justify the plan, say that in "watchOuts" rather than filling the gap with a guess.

Reply with JSON only, in exactly this shape:

${RESPONSE_SHAPE}`;

/** Renders the finished plan as the factual input Claude reasons about. */
export function buildUserMessage(
  recommendation: Recommendation,
  health: HealthReport | null,
): string {
  const { primary, alternatives } = recommendation;

  const lines: string[] = [];

  lines.push(`As of: ${recommendation.asOf}`);
  lines.push(`Funds available for debt this month: ${formatMoney(recommendation.fundsAvailable.value)}`);
  lines.push('');

  if (health !== null) {
    lines.push(`Cash position: ${health.overall}`);
    for (const account of health.accounts) {
      lines.push(
        `  ${account.account.name}: balance ${formatMoney(account.balance)}, cushion ${formatMoney(account.cushion)}, headroom ${formatMoney(account.headroom)} (${account.status})`,
      );
    }
    lines.push('');
  }

  lines.push(`Chosen strategy: ${primary.strategy.name} — ${primary.strategy.rationale}`);
  lines.push('');
  lines.push('The plan (already calculated, do not change these numbers):');
  for (const payment of primary.payments) {
    lines.push(
      `  [id: ${payment.accountId}] ${payment.accountName}` +
        ` — pay ${formatMoney(payment.amount)}` +
        ` (minimum ${formatMoney(payment.minimumPortion)}, extra ${formatMoney(payment.extraPortion)});` +
        ` balance ${formatMoney(payment.openingBalance)} becomes ${formatMoney(payment.closingBalance)}` +
        `${payment.clearsAccount ? ', which clears the account' : ''}.` +
        ` Ranked #${payment.rank}: ${payment.rankReason}`,
    );
  }
  lines.push('');
  lines.push(`Total allocated: ${formatMoney(primary.totalAllocated)}`);
  lines.push(`Left unallocated in cash: ${formatMoney(primary.leftOver)}`);
  lines.push(`Debt remaining after this plan: ${formatMoney(primary.totalDebtAfter)}`);
  lines.push(
    `Interest accruing next month on what remains: ${formatMoney(primary.projectedMonthlyInterest)}`,
  );
  if (!primary.minimumsCovered) {
    lines.push(
      `WARNING: available funds do not cover the contractual minimums; short by ${formatMoney(primary.minimumsShortfall)}.`,
    );
  }
  lines.push('');

  lines.push('Alternatives that were considered and their cost, for comparison:');
  for (const alternative of alternatives) {
    lines.push(
      `  ${alternative.strategy.name}: leaves ${formatMoney(alternative.projectedMonthlyInterest)} accruing next month,` +
        ` clears ${alternative.accountsCleared} account(s). ${alternative.strategy.rationale}`,
    );
  }
  lines.push('');
  lines.push(`Why this one was chosen: ${recommendation.whyPrimary}`);
  lines.push('');
  lines.push('Assumptions the tool made:');
  for (const assumption of recommendation.assumptions) lines.push(`  - ${assumption}`);
  lines.push('');
  lines.push(
    'Explain this plan to the user. Reply with JSON only, using the account ids given in square brackets above.',
  );

  return lines.join('\n');
}

export function buildRequest(
  recommendation: Recommendation,
  health: HealthReport | null,
  model: string,
): ClaudeRequest {
  return {
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserMessage(recommendation, health) }],
    model,
    maxTokens: 1500,
  };
}

/** The account ids the reply is allowed to mention. */
export function allowedAccountIds(recommendation: Recommendation): readonly string[] {
  return recommendation.primary.payments.map((payment) => payment.accountId);
}
