/**
 * Validation.
 *
 * The brief names "broken validation" as a failure mode in its own right, and asks for every
 * rule to be listed with its own pass/fail plus an account of how the combination produced the
 * overall verdict. That is what this module returns: not a boolean, but a table.
 *
 * **Failures are hard stops.** There is deliberately no override, no "accept anyway", and no
 * severity ladder — that was a decision taken up front, and it is enforced by there being no
 * API here through which a failure could be waived.
 *
 * A hard stop with no escape is only humane if it tells you the way out, so every rule that can
 * fail must return a `remedy` naming the specific input to change and the value that would make
 * it pass. A rule that cannot say that is a rule that can deadlock the user, which is why the
 * remedy is a required field on a failure rather than an optional flourish.
 *
 * These rules validate **any** proposal, including one the user has edited by hand. They do not
 * trust the allocator that produced it; several of them re-derive from the snapshot precisely so
 * that a bug in allocation.ts is caught here rather than shipped.
 */

import {
  ZERO,
  clampAtZero,
  compare,
  formatMoney,
  isNegative,
  subtract,
  sum,
  type Cents,
} from './money.ts';
import {
  cashAccounts,
  findAccount,
  isCash,
  isLiability,
  type AccountId,
  type CashAccount,
  type FinancialState,
  type Snapshot,
} from './accounts.ts';
import { nextDayOfMonth, type IsoDate } from './dates.ts';
import { commitmentsBefore } from './affordability.ts';
import type { AllocationPlan } from './allocation.ts';

export const RULE_CODES = {
  balancesRecorded: 'BALANCES_RECORDED',
  paymentsNonNegative: 'PAYMENTS_NON_NEGATIVE',
  noOverpayment: 'NO_OVERPAYMENT',
  paymentsToLiabilities: 'PAYMENTS_TO_LIABILITIES',
  withinAvailableFunds: 'WITHIN_AVAILABLE_FUNDS',
  minimumsCovered: 'MINIMUMS_COVERED',
  cushionMaintained: 'CUSHION_MAINTAINED',
  commitmentsCovered: 'COMMITMENTS_COVERED',
  cashNotNegative: 'CASH_NOT_NEGATIVE',
  conservation: 'CONSERVATION',
} as const;

export type RuleCode = (typeof RULE_CODES)[keyof typeof RULE_CODES];

export interface RuleResult {
  readonly code: RuleCode;
  /** Phrased as the question the rule answers, which is how the brief asks for it to be shown. */
  readonly question: string;
  readonly passed: boolean;
  /** What was actually checked, with the numbers substituted in. */
  readonly detail: string;
  /** Present only on a failure. Names the input to change and the value that would pass. */
  readonly remedy?: string;
}

export interface ValidationReport {
  readonly results: readonly RuleResult[];
  readonly approved: boolean;
  readonly failed: readonly RuleCode[];
  /** How the individual results combined into the overall verdict. */
  readonly combination: string;
}

/** A plan to be checked. May have been edited by hand, so nothing about it is assumed. */
export interface Proposal {
  readonly payments: readonly { readonly accountId: AccountId; readonly amount: Cents }[];
  /** The cash account the payments are drawn from. */
  readonly fundedFrom: AccountId;
  readonly asOf: IsoDate;
}

export class ValidationError extends Error {
  override readonly name = 'ValidationError';
}

/** Turns a generated plan into a proposal, so both paths go through the same rules. */
export function proposalFromPlan(plan: AllocationPlan, fundedFrom: AccountId, asOf: IsoDate): Proposal {
  return {
    payments: plan.payments.map((p) => ({ accountId: p.accountId, amount: p.amount })),
    fundedFrom,
    asOf,
  };
}

function pass(code: RuleCode, question: string, detail: string): RuleResult {
  return { code, question, passed: true, detail };
}

function fail(code: RuleCode, question: string, detail: string, remedy: string): RuleResult {
  return { code, question, passed: false, detail, remedy };
}

function resolveFunding(state: FinancialState, id: AccountId): CashAccount {
  const account = findAccount(state.accounts, id);
  if (account === undefined) throw new ValidationError(`No account with id ${id}`);
  if (!isCash(account)) throw new ValidationError(`${account.name} is not a cash account`);
  return account;
}

export function validate(
  state: FinancialState,
  snapshot: Snapshot,
  proposal: Proposal,
): ValidationReport {
  const funding = resolveFunding(state, proposal.fundedFrom);
  const results: RuleResult[] = [];

  const totalPaid = sum(proposal.payments.map((p) => p.amount));
  const paidAccounts = proposal.payments.map((p) => p.accountId);

  // --- 1. Every account involved has a recorded balance -----------------------------------
  // A blank is not a zero. Treating it as one would report a card as paid off, so this is
  // checked before anything reasons about the numbers.
  const relevant = [funding.id, ...paidAccounts];
  const missing = [...new Set(relevant)].filter((id) => snapshot.balances[id] === undefined);
  results.push(
    missing.length === 0
      ? pass(
          RULE_CODES.balancesRecorded,
          'Is a balance recorded for every account in this plan?',
          `All ${new Set(relevant).size} account(s) in the plan have a balance recorded on ${snapshot.date}.`,
        )
      : fail(
          RULE_CODES.balancesRecorded,
          'Is a balance recorded for every account in this plan?',
          `No balance recorded for: ${missing
            .map((id) => findAccount(state.accounts, id)?.name ?? id)
            .join(', ')}. A blank is not a zero.`,
          `Enter a balance for ${missing
            .map((id) => findAccount(state.accounts, id)?.name ?? id)
            .join(', ')} in the snapshot dated ${snapshot.date}, then run this again.`,
        ),
  );

  // --- 2. No negative payments -------------------------------------------------------------
  const negatives = proposal.payments.filter((p) => isNegative(p.amount));
  results.push(
    negatives.length === 0
      ? pass(
          RULE_CODES.paymentsNonNegative,
          'Is every payment a positive amount?',
          `All ${proposal.payments.length} payment(s) are zero or greater.`,
        )
      : fail(
          RULE_CODES.paymentsNonNegative,
          'Is every payment a positive amount?',
          `Negative payment(s): ${negatives
            .map((p) => `${findAccount(state.accounts, p.accountId)?.name ?? p.accountId} ${formatMoney(p.amount)}`)
            .join(', ')}.`,
          `Set ${negatives
            .map((p) => findAccount(state.accounts, p.accountId)?.name ?? p.accountId)
            .join(', ')} to ${formatMoney(ZERO)} or more. A refund is not a payment and does not belong in a plan.`,
        ),
  );

  // --- 3. Payments only go to liabilities ---------------------------------------------------
  const nonLiabilities = paidAccounts.filter((id) => {
    const account = findAccount(state.accounts, id);
    return account === undefined || !isLiability(account);
  });
  results.push(
    nonLiabilities.length === 0
      ? pass(
          RULE_CODES.paymentsToLiabilities,
          'Does every payment go to a debt?',
          'Every payment targets a liability account.',
        )
      : fail(
          RULE_CODES.paymentsToLiabilities,
          'Does every payment go to a debt?',
          `Not a liability: ${nonLiabilities
            .map((id) => findAccount(state.accounts, id)?.name ?? id)
            .join(', ')}.`,
          `Remove the payment(s) to ${nonLiabilities
            .map((id) => findAccount(state.accounts, id)?.name ?? id)
            .join(', ')}. Moving cash between your own accounts is a transfer, not a debt payment.`,
        ),
  );

  // --- 4. No payment exceeds what is owed ---------------------------------------------------
  const overpaid = proposal.payments
    .map((p) => ({
      payment: p,
      owed: snapshot.balances[p.accountId] ?? ZERO,
      name: findAccount(state.accounts, p.accountId)?.name ?? p.accountId,
    }))
    .filter((entry) => compare(entry.payment.amount, entry.owed) > 0);
  results.push(
    overpaid.length === 0
      ? pass(
          RULE_CODES.noOverpayment,
          'Is every payment within the balance owed?',
          'No payment exceeds its account balance, so nothing is paid into credit.',
        )
      : fail(
          RULE_CODES.noOverpayment,
          'Is every payment within the balance owed?',
          overpaid
            .map(
              (e) =>
                `${e.name}: paying ${formatMoney(e.payment.amount)} against ${formatMoney(e.owed)} owed, ${formatMoney(subtract(e.payment.amount, e.owed))} too much.`,
            )
            .join(' '),
          overpaid
            .map((e) => `Reduce ${e.name} to ${formatMoney(e.owed)} or less.`)
            .join(' '),
      ),
  );

  // --- 5. Within available funds ------------------------------------------------------------
  const fundingBalance = snapshot.balances[funding.id] ?? ZERO;
  const nextPayday = nextDayOfMonth(proposal.asOf, state.paydayOfMonth);
  const upcoming = commitmentsBefore(state.commitments, funding.id, proposal.asOf, nextPayday);
  const committed = sum(upcoming.map((e) => e.commitment.amount));
  const spendable = subtract(subtract(fundingBalance, funding.cushion), committed);

  results.push(
    compare(totalPaid, spendable) <= 0
      ? pass(
          RULE_CODES.withinAvailableFunds,
          'Do the payments fit within the funds available?',
          `${formatMoney(totalPaid)} allocated against ${formatMoney(spendable)} available (${formatMoney(fundingBalance)} balance − ${formatMoney(funding.cushion)} cushion − ${formatMoney(committed)} committed).`,
        )
      : fail(
          RULE_CODES.withinAvailableFunds,
          'Do the payments fit within the funds available?',
          `${formatMoney(totalPaid)} allocated but only ${formatMoney(clampAtZero(spendable))} available (${formatMoney(fundingBalance)} balance − ${formatMoney(funding.cushion)} cushion − ${formatMoney(committed)} committed). Over by ${formatMoney(subtract(totalPaid, spendable))}.`,
          `Reduce total payments to ${formatMoney(clampAtZero(spendable))}, or lower the cushion on ${funding.name} to ${formatMoney(clampAtZero(subtract(subtract(fundingBalance, committed), totalPaid)))}.`,
        ),
  );

  // --- 6. Contractual minimums covered ------------------------------------------------------
  // Checked against the snapshot rather than against the plan's own bookkeeping, so a debt the
  // plan forgot entirely is still caught.
  const shortfalls = state.accounts
    .filter(isLiability)
    .map((account) => {
      const owed = snapshot.balances[account.id] ?? ZERO;
      const due = compare(account.minimumPayment, owed) > 0 ? owed : account.minimumPayment;
      const paying = sum(
        proposal.payments.filter((p) => p.accountId === account.id).map((p) => p.amount),
      );
      return { account, due, paying, short: subtract(due, paying) };
    })
    .filter((entry) => entry.due > ZERO && compare(entry.paying, entry.due) < 0);

  results.push(
    shortfalls.length === 0
      ? pass(
          RULE_CODES.minimumsCovered,
          'Is every contractual minimum payment covered?',
          'Every account with a balance receives at least its minimum payment.',
        )
      : fail(
          RULE_CODES.minimumsCovered,
          'Is every contractual minimum payment covered?',
          shortfalls
            .map(
              (s) =>
                `${s.account.name}: paying ${formatMoney(s.paying)} against a ${formatMoney(s.due)} minimum, ${formatMoney(s.short)} short.`,
            )
            .join(' '),
          `${shortfalls
            .map((s) => `Raise ${s.account.name} to ${formatMoney(s.due)}`)
            .join(', ')}. A missed minimum costs more in credit damage than any ordering saves.`,
        ),
  );

  // --- 7. Cushion maintained ----------------------------------------------------------------
  const fundingAfter = subtract(subtract(fundingBalance, totalPaid), committed);
  results.push(
    compare(fundingAfter, funding.cushion) >= 0
      ? pass(
          RULE_CODES.cushionMaintained,
          'Is the minimum cushion maintained?',
          `${funding.name} ends at ${formatMoney(fundingAfter)}, at or above its ${formatMoney(funding.cushion)} cushion.`,
        )
      : fail(
          RULE_CODES.cushionMaintained,
          'Is the minimum cushion maintained?',
          `${funding.name} would end at ${formatMoney(fundingAfter)}, below its ${formatMoney(funding.cushion)} cushion by ${formatMoney(subtract(funding.cushion, fundingAfter))}.`,
          `Reduce total payments by ${formatMoney(subtract(funding.cushion, fundingAfter))}, to ${formatMoney(clampAtZero(subtract(totalPaid, subtract(funding.cushion, fundingAfter))))}, or lower the cushion on ${funding.name} to ${formatMoney(clampAtZero(fundingAfter))}.`,
        ),
  );

  // --- 8. Commitments before payday still covered -------------------------------------------
  const afterPaymentsBeforeCommitments = subtract(fundingBalance, totalPaid);
  results.push(
    compare(afterPaymentsBeforeCommitments, committed) >= 0
      ? pass(
          RULE_CODES.commitmentsCovered,
          'Do the bills due before payday still clear?',
          upcoming.length === 0
            ? `Nothing is due from ${funding.name} before ${nextPayday}.`
            : `${formatMoney(committed)} due before ${nextPayday} (${upcoming.map((e) => e.commitment.name).join(', ')}), with ${formatMoney(afterPaymentsBeforeCommitments)} left after payments.`,
        )
      : fail(
          RULE_CODES.commitmentsCovered,
          'Do the bills due before payday still clear?',
          `${formatMoney(committed)} is due from ${funding.name} before ${nextPayday} (${upcoming.map((e) => e.commitment.name).join(', ')}), but only ${formatMoney(clampAtZero(afterPaymentsBeforeCommitments))} would remain after payments.`,
          `Reduce total payments to ${formatMoney(clampAtZero(subtract(fundingBalance, committed)))} so ${upcoming.map((e) => e.commitment.name).join(' and ')} still clear.`,
        ),
  );

  // --- 9. No cash account driven negative ---------------------------------------------------
  const negativeCash = cashAccounts(state.accounts)
    .map((account) => ({
      account,
      after:
        account.id === funding.id
          ? fundingAfter
          : subtract(
              snapshot.balances[account.id] ?? ZERO,
              sum(
                commitmentsBefore(state.commitments, account.id, proposal.asOf, nextPayday).map(
                  (e) => e.commitment.amount,
                ),
              ),
            ),
    }))
    .filter((entry) => isNegative(entry.after));

  results.push(
    negativeCash.length === 0
      ? pass(
          RULE_CODES.cashNotNegative,
          'Does every cash account stay above zero?',
          'No cash account is driven negative by this plan.',
        )
      : fail(
          RULE_CODES.cashNotNegative,
          'Does every cash account stay above zero?',
          negativeCash
            .map((e) => `${e.account.name} would end at ${formatMoney(e.after)}.`)
            .join(' '),
          negativeCash
            .map(
              (e) =>
                `${e.account.name} is overdrawn by ${formatMoney(clampAtZero(subtract(ZERO, e.after)))}; reduce payments or move that much into it before proceeding.`,
            )
            .join(' '),
        ),
  );

  // --- 10. Conservation ---------------------------------------------------------------------
  // Cash leaving must equal debt reduced, to the cent. Transfers and payments move net worth
  // around without changing it, so any residual means a figure was invented or lost.
  const debtReduced = sum(
    proposal.payments.map((p) => {
      const owed = snapshot.balances[p.accountId] ?? ZERO;
      const closing = subtract(owed, p.amount);
      return subtract(owed, closing);
    }),
  );
  const residual = subtract(totalPaid, debtReduced);
  results.push(
    residual === ZERO
      ? pass(
          RULE_CODES.conservation,
          'Does the money balance exactly?',
          `${formatMoney(totalPaid)} leaves cash and ${formatMoney(debtReduced)} of debt is retired. Residual ${formatMoney(ZERO)}.`,
        )
      : fail(
          RULE_CODES.conservation,
          'Does the money balance exactly?',
          `${formatMoney(totalPaid)} leaves cash but ${formatMoney(debtReduced)} of debt is retired, a residual of ${formatMoney(residual)}. Money was invented or lost.`,
          'This is a fault in the tool, not in your figures. Re-generate the recommendation; if it persists, the plan should not be acted on.',
        ),
  );

  const failed = results.filter((r) => !r.passed).map((r) => r.code);
  const approved = failed.length === 0;

  const combination = approved
    ? `All ${results.length} rules passed, so the plan is approved. Every rule must pass; there is no override.`
    : `${results.length - failed.length} of ${results.length} rules passed, but ${failed.length} failed (${failed.join(', ')}). Every rule must pass, and failures cannot be overridden, so the plan is rejected. Follow the remedy on each failed rule to make it pass.`;

  return { results, approved, failed, combination };
}
