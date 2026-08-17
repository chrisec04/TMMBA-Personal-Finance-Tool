/**
 * Debt allocation.
 *
 * This is the one genuinely new thing in the tool, and the brief flags "incorrect allocation
 * suggestion" as a top failure mode. Its prescribed response is not a better model: it is to
 * show the reasoning for the primary plan alongside alternatives, so the choice can be judged
 * rather than trusted.
 *
 * Two consequences shape this module.
 *
 * First, **the allocation is computed here, in ordinary arithmetic, not by Claude.** Claude is
 * asked to explain and to argue; it is never the source of a figure. Every number the UI shows
 * comes from this file, which is exhaustively tested, rather than from a sampled token stream.
 *
 * Second, alternatives are not decoration. All four strategies are always computed, scored
 * against the same objective measure, and returned together — so "why this one" is answerable
 * by comparing rows in a table instead of by reading a paragraph.
 */

import {
  ZERO,
  add,
  clampAtZero,
  formatMoney,
  isNegative,
  isPositive,
  minimum,
  multiply,
  subtract,
  sum,
  type Cents,
} from './money.ts';
import {
  CREDIT_IMPACT_WEIGHT,
  findAccount,
  isCash,
  liabilityAccounts,
  type AccountId,
  type FinancialState,
  type LiabilityAccount,
  type Snapshot,
} from './accounts.ts';
import { nextDayOfMonth, type IsoDate } from './dates.ts';
import { Trace, type Traced } from './explain.ts';
import { commitmentsBefore } from './affordability.ts';

export type StrategyId = 'avalanche' | 'snowball' | 'credit-impact' | 'highest-balance';

export interface StrategyMeta {
  readonly id: StrategyId;
  readonly name: string;
  readonly rationale: string;
}

export const STRATEGIES: Readonly<Record<StrategyId, StrategyMeta>> = {
  avalanche: {
    id: 'avalanche',
    name: 'Highest interest rate first',
    rationale:
      'Attacks the most expensive debt first. Costs the least in interest overall, which is the objectively cheapest order.',
  },
  snowball: {
    id: 'snowball',
    name: 'Smallest balance first',
    rationale:
      'Clears whole accounts soonest. Costs a little more in interest, but each payoff frees up a minimum payment and gives visible progress.',
  },
  'credit-impact': {
    id: 'credit-impact',
    name: 'Credit score impact first',
    rationale:
      'Targets the balances that weigh most on a credit score. Worth choosing when a score matters soon, such as before applying for a loan.',
  },
  'highest-balance': {
    id: 'highest-balance',
    name: 'Largest balance first',
    rationale:
      'Reduces the biggest single debt first. Intuitive and simple to follow, but usually the most expensive of the four.',
  },
};

/** A debt with a balance, ready to be ranked. */
interface RankableDebt {
  readonly account: LiabilityAccount;
  readonly balance: Cents;
}

export interface Payment {
  readonly accountId: AccountId;
  readonly accountName: string;
  readonly amount: Cents;
  /** The portion of `amount` that is the contractual minimum. */
  readonly minimumPortion: Cents;
  /** The portion above the minimum, allocated by the strategy. */
  readonly extraPortion: Cents;
  readonly openingBalance: Cents;
  readonly closingBalance: Cents;
  /** True when this payment clears the account outright. */
  readonly clearsAccount: boolean;
  readonly rank: number;
  readonly rankReason: string;
}

export interface AllocationPlan {
  readonly strategy: StrategyMeta;
  readonly payments: readonly Payment[];
  readonly totalAllocated: Cents;
  readonly fundsAvailable: Cents;
  readonly leftOver: Cents;
  /** Whether every contractual minimum was covered. */
  readonly minimumsCovered: boolean;
  readonly minimumsShortfall: Cents;
  readonly accountsCleared: number;
  /** Estimated interest accruing next month on what is left. Lower is better. */
  readonly projectedMonthlyInterest: Cents;
  readonly totalDebtAfter: Cents;
  readonly explanation: Traced<Cents>;
}

export interface Recommendation {
  readonly asOf: IsoDate;
  readonly fundsAvailable: Traced<Cents>;
  readonly primary: AllocationPlan;
  /** The other three strategies, ordered best-first by projected interest. */
  readonly alternatives: readonly AllocationPlan[];
  readonly whyPrimary: string;
  readonly assumptions: readonly string[];
}

export class AllocationError extends Error {
  override readonly name = 'AllocationError';
}

/**
 * How much cash is genuinely free to put against debt.
 *
 * Measured on the **funding account alone**, not on total cash. Pooling checking and savings
 * would let a plan spend money that is not where the payments come from, and quietly assume a
 * transfer the user never agreed to — and moving money between their own accounts is explicitly
 * a human decision in this tool, not one the allocator gets to make.
 *
 * The cushion and everything promised before payday come off first. The brief makes "validate
 * the minimum checking cushion is maintained" part of the recommendation itself, so a plan that
 * breaches it is never generated in the first place rather than caught afterwards.
 */
export function fundsAvailableForDebt(
  state: FinancialState,
  snapshot: Snapshot,
  asOf: IsoDate,
  fundedFrom: AccountId = state.primaryCashAccountId,
): Traced<Cents> {
  const trace = new Trace();

  const account = findAccount(state.accounts, fundedFrom);
  if (account === undefined) throw new AllocationError(`No account with id ${fundedFrom}`);
  if (!isCash(account)) {
    throw new AllocationError(`${account.name} is not a cash account, so it cannot fund payments`);
  }

  const balance = snapshot.balances[account.id] ?? ZERO;
  trace.assume(
    'Funding account',
    account.name,
    'Payments are drawn from this account only. Moving money in from savings is your decision, not the tool\u2019s.',
  );
  trace.money('Balance', 'given', [['balance', balance]], balance);

  const nextPayday = nextDayOfMonth(asOf, state.paydayOfMonth);
  const upcoming = commitmentsBefore(state.commitments, account.id, asOf, nextPayday);
  const committed = sum(upcoming.map((entry) => entry.commitment.amount));

  if (upcoming.length === 0) {
    trace.assume('Committed before payday', formatMoney(ZERO), `Nothing is due from ${account.name} before ${nextPayday}.`);
  } else {
    trace.money(
      'Committed before payday',
      upcoming.map((e) => e.commitment.name).join(' + '),
      upcoming.map((e) => [e.commitment.name, e.commitment.amount] as const),
      committed,
      `Due on or before ${nextPayday}.`,
    );
  }

  const available = trace.money(
    'Funds available for debt',
    'balance - cushion - committed',
    [
      ['balance', balance],
      ['cushion', account.cushion],
      ['committed', committed],
    ],
    clampAtZero(subtract(subtract(balance, account.cushion), committed)),
    'Clamped at zero: a negative figure means there is nothing to allocate, not a debt to take on.',
  );

  return trace.finish(available);
}

/** Debts carrying a balance, in the order a strategy dictates. */
function rank(debts: readonly RankableDebt[], strategy: StrategyId): readonly RankableDebt[] {
  const byId = (a: RankableDebt, b: RankableDebt): number =>
    a.account.id < b.account.id ? -1 : a.account.id > b.account.id ? 1 : 0;

  const sorted = [...debts];
  switch (strategy) {
    case 'avalanche':
      // Most expensive money first. Ties broken by balance so the larger accrual wins.
      sorted.sort((a, b) => b.account.apr - a.account.apr || b.balance - a.balance || byId(a, b));
      break;
    case 'snowball':
      sorted.sort((a, b) => a.balance - b.balance || b.account.apr - a.account.apr || byId(a, b));
      break;
    case 'credit-impact':
      sorted.sort(
        (a, b) =>
          CREDIT_IMPACT_WEIGHT[b.account.creditImpact] - CREDIT_IMPACT_WEIGHT[a.account.creditImpact] ||
          b.account.apr - a.account.apr ||
          byId(a, b),
      );
      break;
    case 'highest-balance':
      sorted.sort((a, b) => b.balance - a.balance || b.account.apr - a.account.apr || byId(a, b));
      break;
  }
  return sorted;
}

function rankReasonFor(debt: RankableDebt, strategy: StrategyId, position: number): string {
  const apr = `${(debt.account.apr * 100).toFixed(2)}%`;
  const balance = formatMoney(debt.balance);
  switch (strategy) {
    case 'avalanche':
      return `#${position}: APR ${apr}, the ${position === 1 ? 'highest' : 'next highest'} rate, so every dollar here saves the most interest. Balance ${balance}.`;
    case 'snowball':
      return `#${position}: balance ${balance}, the ${position === 1 ? 'smallest' : 'next smallest'}, so it clears soonest and frees its minimum payment. APR ${apr}.`;
    case 'credit-impact':
      return `#${position}: ${debt.account.creditImpact} credit-score impact. Balance ${balance}, APR ${apr}.`;
    case 'highest-balance':
      return `#${position}: balance ${balance}, the ${position === 1 ? 'largest' : 'next largest'} single debt. APR ${apr}.`;
  }
}

/** One month of interest on a balance, used only to compare plans against each other. */
function monthlyInterest(balance: Cents, apr: number): Cents {
  return multiply(balance, apr / 12);
}

/**
 * Builds one plan.
 *
 * Minimums are reserved before any strategy runs. Missing a contractual minimum damages a credit
 * score far more than any ordering choice can repair, so no strategy is permitted to trade one
 * away — whatever is left after minimums is the only thing being optimised.
 */
export function buildPlan(
  state: FinancialState,
  snapshot: Snapshot,
  fundsAvailable: Cents,
  strategy: StrategyId,
): AllocationPlan {
  if (isNegative(fundsAvailable)) {
    throw new AllocationError('Funds available cannot be negative');
  }

  const meta = STRATEGIES[strategy];
  const trace = new Trace();

  const debts: RankableDebt[] = liabilityAccounts(state.accounts)
    .map((account) => ({ account, balance: snapshot.balances[account.id] ?? ZERO }))
    .filter((debt) => isPositive(debt.balance));

  trace.assume(
    'Strategy',
    meta.name,
    meta.rationale,
  );
  trace.money('Funds available', 'given', [['funds', fundsAvailable]], fundsAvailable);

  // Step 1: reserve the contractual minimums, capped at the balance so a nearly-cleared card
  // is never asked for more than it owes.
  const minimums = new Map<AccountId, Cents>();
  for (const debt of debts) {
    minimums.set(debt.account.id, minimum(debt.account.minimumPayment, debt.balance));
  }
  const minimumsTotal = sum([...minimums.values()]);

  const minimumsCovered = minimumsTotal <= fundsAvailable;
  const minimumsShortfall = clampAtZero(subtract(minimumsTotal, fundsAvailable));

  if (debts.length === 0) {
    trace.assume('Minimums due', formatMoney(ZERO), 'No account carries a balance.');
  } else {
    trace.money(
      'Minimums due',
      debts.map((d) => `${d.account.name} min`).join(' + '),
      debts.map((d) => [`${d.account.name} min`, minimums.get(d.account.id) ?? ZERO] as const),
      minimumsTotal,
      'Reserved first. No strategy is allowed to skip a contractual minimum.',
    );
  }

  const allocated = new Map<AccountId, Cents>();
  let remaining = fundsAvailable;

  // Pay minimums in strategy order, so that when funds are short the shortfall lands on the
  // debt the strategy considers least urgent rather than on an arbitrary one.
  const ordered = rank(debts, strategy);
  for (const debt of ordered) {
    const due = minimums.get(debt.account.id) ?? ZERO;
    const pay = minimum(due, remaining);
    allocated.set(debt.account.id, pay);
    remaining = subtract(remaining, pay);
  }

  const afterMinimums = trace.money(
    'Left after minimums',
    'funds - minimums',
    [
      ['funds', fundsAvailable],
      ['minimums', minimum(minimumsTotal, fundsAvailable)],
    ],
    remaining,
    'This is the only money the strategy actually gets to order.',
  );

  // Step 2: pour whatever is left down the ranked list, never past a zero balance. Stopping at
  // the balance is what turns "pay the most expensive first" into a payoff when the money
  // reaches that far.
  for (const debt of ordered) {
    if (!isPositive(remaining)) break;
    const already = allocated.get(debt.account.id) ?? ZERO;
    const room = subtract(debt.balance, already);
    if (!isPositive(room)) continue;
    const extra = minimum(room, remaining);
    allocated.set(debt.account.id, add(already, extra));
    remaining = subtract(remaining, extra);
  }

  const payments: Payment[] = ordered.map((debt, index) => {
    const amount = allocated.get(debt.account.id) ?? ZERO;
    const minimumPortion = minimum(minimums.get(debt.account.id) ?? ZERO, amount);
    const closing = subtract(debt.balance, amount);
    return {
      accountId: debt.account.id,
      accountName: debt.account.name,
      amount,
      minimumPortion,
      extraPortion: subtract(amount, minimumPortion),
      openingBalance: debt.balance,
      closingBalance: closing,
      clearsAccount: closing === ZERO && isPositive(debt.balance),
      rank: index + 1,
      rankReason: rankReasonFor(debt, strategy, index + 1),
    };
  });

  const totalAllocated = sum(payments.map((p) => p.amount));
  trace.money(
    'Total allocated',
    payments.map((p) => p.accountName).join(' + ') || 'nothing',
    payments.map((p) => [p.accountName, p.amount] as const),
    totalAllocated,
  );

  const leftOver = trace.money(
    'Unallocated',
    'funds - allocated',
    [
      ['funds', fundsAvailable],
      ['allocated', totalAllocated],
    ],
    subtract(fundsAvailable, totalAllocated),
    'Left in cash because every balance is already cleared.',
  );

  const projectedMonthlyInterest = sum(
    payments.map((p) => {
      const account = debts.find((d) => d.account.id === p.accountId)?.account;
      return account === undefined ? ZERO : monthlyInterest(p.closingBalance, account.apr);
    }),
  );

  trace.money(
    'Interest next month on what remains',
    payments.map((p) => `${p.accountName} residual interest`).join(' + ') || 'none',
    payments.map((p) => {
      const account = debts.find((d) => d.account.id === p.accountId)?.account;
      return [
        `${p.accountName} residual interest`,
        account === undefined ? ZERO : monthlyInterest(p.closingBalance, account.apr),
      ] as const;
    }),
    projectedMonthlyInterest,
    'balance after payment x APR / 12, for each account. This is the score used to compare strategies.',
  );

  void afterMinimums;

  return {
    strategy: meta,
    payments,
    totalAllocated,
    fundsAvailable,
    leftOver,
    minimumsCovered,
    minimumsShortfall,
    accountsCleared: payments.filter((p) => p.clearsAccount).length,
    projectedMonthlyInterest,
    totalDebtAfter: sum(payments.map((p) => p.closingBalance)),
    explanation: trace.finish(totalAllocated),
  };
}

const ALL_STRATEGIES: readonly StrategyId[] = [
  'avalanche',
  'snowball',
  'credit-impact',
  'highest-balance',
];

/**
 * The full recommendation: one primary plan and the three it was chosen over.
 *
 * The primary is the avalanche because it is the only ordering that is *provably* cheapest in
 * interest, and the brief asks for a defensible recommendation rather than a popular one. The
 * comparison table is what makes that claim checkable: if another strategy scored better on
 * this month's interest, the numbers would say so.
 */
export function recommend(
  state: FinancialState,
  snapshot: Snapshot,
  asOf: IsoDate,
  preferred: StrategyId = 'avalanche',
  fundedFrom: AccountId = state.primaryCashAccountId,
): Recommendation {
  const funds = fundsAvailableForDebt(state, snapshot, asOf, fundedFrom);
  const plans = ALL_STRATEGIES.map((id) => buildPlan(state, snapshot, funds.value, id));

  const primary = plans.find((plan) => plan.strategy.id === preferred);
  if (primary === undefined) throw new AllocationError(`Unknown strategy ${preferred}`);

  const alternatives = plans
    .filter((plan) => plan.strategy.id !== preferred)
    .sort((a, b) => a.projectedMonthlyInterest - b.projectedMonthlyInterest);

  const best = [...plans].sort(
    (a, b) => a.projectedMonthlyInterest - b.projectedMonthlyInterest,
  )[0];

  const cheapest = best ?? primary;
  const whyPrimary =
    cheapest.strategy.id === primary.strategy.id
      ? `${primary.strategy.name} leaves the least interest accruing next month, ${formatMoney(primary.projectedMonthlyInterest)}, so it is also the cheapest of the four. ${primary.strategy.rationale}`
      : `${primary.strategy.name} was chosen for its stated reason, not on cost: it leaves ${formatMoney(primary.projectedMonthlyInterest)} accruing next month, against ${formatMoney(cheapest.projectedMonthlyInterest)} for ${cheapest.strategy.name}. The difference is ${formatMoney(subtract(primary.projectedMonthlyInterest, cheapest.projectedMonthlyInterest))} a month.`;

  const assumptions: string[] = [
    `Balances are as entered on ${snapshot.date}; nothing is retrieved from a bank.`,
    'Payments are drawn from one cash account. Moving money in from another account is your decision, and is not assumed here.',
    'That account\u2019s cushion is reserved before any money is allocated, so no plan can breach it.',
    'Contractual minimums are reserved before the strategy orders anything.',
    'Interest is compared as one month at APR / 12 on the balance left after payment. It is a comparison score between plans, not a forecast of what will be charged.',
    'Payments are assumed to be made in full and on time. Nothing is executed by this tool.',
  ];
  if (!primary.minimumsCovered) {
    assumptions.push(
      `Available funds do not cover the minimum payments; ${formatMoney(primary.minimumsShortfall)} is short.`,
    );
  }

  return {
    asOf,
    fundsAvailable: funds,
    primary,
    alternatives,
    whyPrimary,
    assumptions,
  };
}
