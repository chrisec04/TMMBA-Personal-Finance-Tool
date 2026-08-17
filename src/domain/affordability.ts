/**
 * Affordability.
 *
 * "Can I buy this?" is the question the brief expects to be answered in a hurry, at the till.
 * The naive answer compares the price to the balance, which is exactly how a green light on the
 * 3rd becomes a bounced rent payment on the 1st.
 *
 * So the answer here is always "yes/no *until payday*": the money already promised to bills
 * between now and the next time you are paid is taken off the top before anything is called
 * affordable. That is a deliberate choice recorded in the plan, and it is why this module needs
 * dates at all.
 *
 * No network call happens on this path. The whole calculation is arithmetic, so the brief's
 * 3-second budget is met by construction rather than by hope.
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
  findAccount,
  isCash,
  type AccountId,
  type CashAccount,
  type Commitment,
  type FinancialState,
  type Snapshot,
} from './accounts.ts';
import { compareIsoDates, nextDayOfMonth, type IsoDate } from './dates.ts';
import { Trace, type Traced } from './explain.ts';

/** How sure the answer is, computed from the data — never from a model's self-report. */
export type AffordabilityConfidence = 'high' | 'moderate' | 'low';

export interface UpcomingCommitment {
  readonly commitment: Commitment;
  readonly dueDate: IsoDate;
}

export interface AffordabilityQuestion {
  readonly amount: Cents;
  /** Which cash account it would come out of. Defaults to the primary one. */
  readonly fromAccountId?: AccountId;
  readonly asOf: IsoDate;
  readonly description?: string;
}

export interface AffordabilityAnswer {
  readonly affordable: boolean;
  readonly confidence: AffordabilityConfidence;
  readonly account: CashAccount;
  readonly amount: Cents;
  readonly openingBalance: Cents;
  /** Commitments falling due between now and the next payday, on this account. */
  readonly upcoming: readonly UpcomingCommitment[];
  readonly committedTotal: Cents;
  readonly nextPayday: IsoDate;
  /** Balance after the purchase and the upcoming commitments have all cleared. */
  readonly projectedBalance: Cents;
  /** Spendable headroom before the purchase: balance - cushion - commitments. */
  readonly availableToSpend: Cents;
  /** How much the cushion would be eaten into. Zero when the cushion survives intact. */
  readonly cushionShortfall: Cents;
  readonly reasoning: string;
  readonly assumptions: readonly string[];
  readonly explanation: Traced<Cents>;
}

export class AffordabilityError extends Error {
  override readonly name = 'AffordabilityError';
}

/**
 * Commitments due from `asOf` up to and including the next payday.
 *
 * The window ends at payday because that is when the position resets. Looking further would
 * make every purchase look unaffordable; looking no further than today would make every
 * purchase look affordable. Payday is the honest horizon.
 */
export function commitmentsBefore(
  commitments: readonly Commitment[],
  accountId: AccountId,
  asOf: IsoDate,
  until: IsoDate,
): readonly UpcomingCommitment[] {
  return commitments
    .filter((commitment) => commitment.fundedBy === accountId)
    .map((commitment) => ({
      commitment,
      dueDate: nextDayOfMonth(asOf, commitment.dayOfMonth),
    }))
    .filter(({ dueDate }) => compareIsoDates(dueDate, until) <= 0)
    .sort((a, b) => compareIsoDates(a.dueDate, b.dueDate));
}

function resolveAccount(state: FinancialState, id: AccountId | undefined): CashAccount {
  const targetId = id ?? state.primaryCashAccountId;
  const account = findAccount(state.accounts, targetId);
  if (account === undefined) {
    throw new AffordabilityError(`No account with id ${targetId}`);
  }
  if (!isCash(account)) {
    throw new AffordabilityError(`${account.name} is not a cash account, so it cannot fund a purchase`);
  }
  return account;
}

/**
 * Confidence in the answer, from the completeness of the inputs and the size of the margin.
 *
 * Deterministic and reproducible. A knife-edge answer is reported as such, because "yes, by
 * $3.10" and "yes, by $900" deserve different levels of trust even though both are yes.
 */
function assessConfidence(
  margin: Cents,
  balanceWasMissing: boolean,
  amount: Cents,
): { confidence: AffordabilityConfidence; why: string } {
  if (balanceWasMissing) {
    return {
      confidence: 'low',
      why: 'No balance was recorded for this account, so the answer rests on an assumed figure.',
    };
  }

  // A margin thinner than a tenth of the purchase, or than $50, is close enough that a single
  // forgotten charge would flip the answer.
  const relative = Math.abs(amount) / 10;
  const threshold = Math.max(relative, 5000);
  if (Math.abs(margin) < threshold) {
    return {
      confidence: 'moderate',
      why: `The margin is ${formatMoney(margin)}, which is thin enough that one unrecorded charge could change the answer.`,
    };
  }

  return {
    confidence: 'high',
    why: `The margin is ${formatMoney(margin)}, comfortably clear of the decision boundary.`,
  };
}

export function checkAffordability(
  state: FinancialState,
  snapshot: Snapshot,
  question: AffordabilityQuestion,
): AffordabilityAnswer {
  if (isNegative(question.amount)) {
    throw new AffordabilityError('A purchase amount cannot be negative');
  }

  const account = resolveAccount(state, question.fromAccountId);
  const recorded = snapshot.balances[account.id];
  const balanceWasMissing = recorded === undefined;
  const openingBalance = recorded ?? ZERO;

  const nextPayday = nextDayOfMonth(question.asOf, state.paydayOfMonth);
  const upcoming = commitmentsBefore(state.commitments, account.id, question.asOf, nextPayday);
  const committedTotal = sum(upcoming.map((entry) => entry.commitment.amount));

  const trace = new Trace();

  trace.assume(
    'Balance as recorded',
    formatMoney(openingBalance),
    `${account.name}, from the snapshot dated ${snapshot.date}.`,
  );
  trace.assume(
    'Next payday',
    nextPayday,
    `Income arrives on day ${state.paydayOfMonth} of the month, so that is the horizon for this answer.`,
  );

  if (upcoming.length === 0) {
    trace.assume(
      'Committed before payday',
      formatMoney(ZERO),
      'Nothing is scheduled to leave this account before payday.',
    );
  } else {
    trace.money(
      'Committed before payday',
      upcoming.map((entry) => entry.commitment.name).join(' + '),
      upcoming.map((entry) => [entry.commitment.name, entry.commitment.amount] as const),
      committedTotal,
      `Due on or before ${nextPayday}: ${upcoming
        .map((entry) => `${entry.commitment.name} on ${entry.dueDate}`)
        .join(', ')}.`,
    );
  }

  const afterCommitments = trace.money(
    'Balance after commitments',
    'balance - committed',
    [
      ['balance', openingBalance],
      ['committed', committedTotal],
    ],
    subtract(openingBalance, committedTotal),
    'What is left once everything already promised has cleared.',
  );

  const availableToSpend = trace.money(
    'Available to spend',
    'afterCommitments - cushion',
    [
      ['afterCommitments', afterCommitments],
      ['cushion', account.cushion],
    ],
    subtract(afterCommitments, account.cushion),
    `Spendable without breaching the ${formatMoney(account.cushion)} cushion on ${account.name}.`,
  );

  const margin = trace.money(
    'Margin',
    'available - purchase',
    [
      ['available', availableToSpend],
      ['purchase', question.amount],
    ],
    subtract(availableToSpend, question.amount),
    'Positive means the purchase fits with the cushion intact.',
  );

  const projectedBalance = trace.money(
    'Projected balance',
    'afterCommitments - purchase',
    [
      ['afterCommitments', afterCommitments],
      ['purchase', question.amount],
    ],
    subtract(afterCommitments, question.amount),
    'Where the account lands once the purchase and the commitments have all cleared.',
  );

  const affordable = compare(margin, ZERO) >= 0;
  const cushionShortfall = clampAtZero(subtract(account.cushion, projectedBalance));

  const { confidence, why } = assessConfidence(margin, balanceWasMissing, question.amount);

  trace.plain(
    'Verdict',
    'margin >= 0',
    [['margin', formatMoney(margin)]],
    affordable ? 'affordable' : 'not affordable',
  );

  const label = question.description ?? formatMoney(question.amount);
  const reasoning = affordable
    ? `Yes. After ${formatMoney(committedTotal)} of commitments due before ${nextPayday}, ${formatMoney(availableToSpend)} is spendable while keeping the ${formatMoney(account.cushion)} cushion on ${account.name} intact. ${label} leaves ${formatMoney(margin)} of that margin, ending at ${formatMoney(projectedBalance)}.`
    : `No. After ${formatMoney(committedTotal)} of commitments due before ${nextPayday}, only ${formatMoney(clampAtZero(availableToSpend))} is spendable while keeping the ${formatMoney(account.cushion)} cushion on ${account.name} intact. ${label} is ${formatMoney(subtract(question.amount, availableToSpend))} more than that, and would leave ${formatMoney(projectedBalance)}.`;

  const assumptions: string[] = [
    `Balances are as entered on ${snapshot.date}; nothing is retrieved from a bank.`,
    `The horizon is the next payday, ${nextPayday}. Spending after that is not considered.`,
    `Only commitments funded from ${account.name} are counted.`,
    why,
  ];
  if (balanceWasMissing) {
    assumptions.push(
      `No balance was recorded for ${account.name}; ${formatMoney(ZERO)} was assumed, which is why confidence is low.`,
    );
  }
  if (upcoming.length === 0 && state.commitments.length > 0) {
    assumptions.push('No recorded commitment falls due before payday, which is worth sanity-checking.');
  }

  return {
    affordable,
    confidence,
    account,
    amount: question.amount,
    openingBalance,
    upcoming,
    committedTotal,
    nextPayday,
    projectedBalance,
    availableToSpend,
    cushionShortfall,
    reasoning,
    assumptions,
    explanation: trace.finish(margin),
  };
}
