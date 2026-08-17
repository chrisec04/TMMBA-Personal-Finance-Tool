/**
 * The twenty scenarios.
 *
 * The build brief makes math accuracy the load-bearing metric: twenty debt-allocation scenarios,
 * every intermediate and final value correct, target 100%, and "if any calculation fails, the
 * tool is not deployment-ready".
 *
 * This file is that gate. Every expected figure is worked out **by hand** in the comment above
 * the scenario and typed in as a literal. None of it was copied from the code's output, because
 * a expectation harvested from the implementation only proves the implementation is stable — it
 * cannot prove it is correct. Where a value is a rounding decision, the working shows the
 * fraction and the direction it was rounded.
 *
 * The scenarios are chosen to cover the ways this arithmetic could plausibly go wrong rather
 * than to be twenty variations of the same sum: strategy ordering, tie-breaking, payoff
 * opportunities, insufficient funds, capped minimums, cent-level conservation, large balances,
 * commitment windows, and the cases that must be rejected outright.
 */

import { parseMoney, type Cents } from '../src/domain/money.ts';
import type {
  AccountId,
  Account,
  Commitment,
  FinancialState,
  CreditImpact,
  Snapshot,
} from '../src/domain/accounts.ts';
import type { StrategyId } from '../src/domain/allocation.ts';
import type { RuleCode } from '../src/domain/validation.ts';
import type { IsoDate } from '../src/domain/dates.ts';

const CHK = 'chk' as AccountId;

function cash(id: string, name: string, cushion: string): Account {
  return { id: id as AccountId, kind: 'cash', name, cushion: parseMoney(cushion) };
}

function debt(
  id: string,
  name: string,
  apr: number,
  minimumPayment: string,
  creditImpact: CreditImpact,
): Account {
  return {
    id: id as AccountId,
    kind: 'liability',
    name,
    apr,
    minimumPayment: parseMoney(minimumPayment),
    creditImpact,
  };
}

function rent(amount: string, dayOfMonth: number): Commitment {
  return {
    id: 'rent',
    name: 'Rent',
    amount: parseMoney(amount),
    dayOfMonth,
    fundedBy: CHK,
  };
}

function state(accounts: readonly Account[], commitments: readonly Commitment[] = []): FinancialState {
  return {
    accounts,
    commitments,
    history: [],
    paydayOfMonth: 15,
    primaryCashAccountId: CHK,
  };
}

function snapshot(date: IsoDate, balances: Readonly<Record<string, string>>): Snapshot {
  const parsed: Record<string, Cents> = {};
  for (const [id, value] of Object.entries(balances)) parsed[id] = parseMoney(value);
  return { date, balances: parsed };
}

export interface ScenarioExpectation {
  /** Funding account balance, less its cushion, less anything due before payday. */
  readonly fundsAvailable: string;
  /** Payment per account, formatted. Accounts with no balance are absent. */
  readonly payments: Readonly<Record<string, string>>;
  readonly totalAllocated: string;
  readonly leftOver: string;
  readonly closing: Readonly<Record<string, string>>;
  readonly minimumsCovered: boolean;
  readonly accountsCleared: number;
  /** Interest accruing next month on what remains, at APR / 12. */
  readonly monthlyInterest: string;
  readonly approved: boolean;
  readonly failedRules?: readonly RuleCode[];
}

export interface Scenario {
  readonly id: string;
  readonly title: string;
  /** The mistake this scenario exists to catch. */
  readonly guards: string;
  readonly state: FinancialState;
  readonly snapshot: Snapshot;
  readonly asOf: IsoDate;
  readonly strategy: StrategyId;
  /** A hand-edited proposal to validate instead of the generated plan. */
  readonly manualPayments?: Readonly<Record<string, string>>;
  readonly expect: ScenarioExpectation;
}

const DAY = '2026-03-05' as IsoDate;

/**
 * The shared three-debt position, used by scenarios 1-4 so the four strategies can be compared
 * on identical inputs.
 *
 *   checking $3,000.00, cushion $1,000.00, nothing due before payday
 *   card A   $2,000.00  24.00%  min $50.00   high impact
 *   card B     $800.00  18.00%  min $25.00   medium impact
 *   loan    $10,000.00   6.00%  min $200.00  low impact
 *
 *   funds available = $3,000.00 - $1,000.00 - $0.00 = $2,000.00
 *   minimums due    = $50.00 + $25.00 + $200.00     = $275.00
 *   left to order   = $2,000.00 - $275.00           = $1,725.00
 */
const THREE_DEBTS = state([
  cash('chk', 'Checking', '1000.00'),
  debt('a', 'Card A', 0.24, '50.00', 'high'),
  debt('b', 'Card B', 0.18, '25.00', 'medium'),
  debt('l', 'Loan', 0.06, '200.00', 'low'),
]);

const THREE_DEBTS_BALANCES = snapshot(DAY, {
  chk: '3000.00',
  a: '2000.00',
  b: '800.00',
  l: '10000.00',
});

export const SCENARIOS: readonly Scenario[] = [
  /**
   * 01. Avalanche on the shared position.
   *   order by APR:  A 24%, B 18%, loan 6%
   *   A = $50.00 + $1,725.00 = $1,775.00, leaving $2,000.00 - $1,775.00 = $225.00
   *   B = $25.00                          leaving $800.00 - $25.00      = $775.00
   *   L = $200.00                         leaving $10,000.00 - $200.00  = $9,800.00
   *   interest: $225.00 x .02 = $4.50; $775.00 x .015 = $11.625 -> $11.63; $9,800 x .005 = $49.00
   *   total interest = $4.50 + $11.63 + $49.00 = $65.13
   */
  {
    id: '01-avalanche',
    title: 'Avalanche puts everything spare on the highest rate',
    guards: 'Strategy ordering, and that the surplus stops at the balance rather than overshooting.',
    state: THREE_DEBTS,
    snapshot: THREE_DEBTS_BALANCES,
    asOf: DAY,
    strategy: 'avalanche',
    expect: {
      fundsAvailable: '$2,000.00',
      payments: { a: '$1,775.00', b: '$25.00', l: '$200.00' },
      totalAllocated: '$2,000.00',
      leftOver: '$0.00',
      closing: { a: '$225.00', b: '$775.00', l: '$9,800.00' },
      minimumsCovered: true,
      accountsCleared: 0,
      monthlyInterest: '$65.13',
      approved: true,
    },
  },

  /**
   * 02. Snowball on the same position.
   *   order by balance: B $800, A $2,000, loan $10,000
   *   B = $25.00 + $775.00   = $800.00, cleared
   *   A = $50.00 + $950.00   = $1,000.00, leaving $1,000.00
   *   L = $200.00                        leaving $9,800.00
   *   interest: $0.00 + ($1,000.00 x .02 = $20.00) + $49.00 = $69.00
   */
  {
    id: '02-snowball',
    title: 'Snowball clears the smallest account first',
    guards: 'That a different ordering produces a different, still-conserved plan.',
    state: THREE_DEBTS,
    snapshot: THREE_DEBTS_BALANCES,
    asOf: DAY,
    strategy: 'snowball',
    expect: {
      fundsAvailable: '$2,000.00',
      payments: { b: '$800.00', a: '$1,000.00', l: '$200.00' },
      totalAllocated: '$2,000.00',
      leftOver: '$0.00',
      closing: { b: '$0.00', a: '$1,000.00', l: '$9,800.00' },
      minimumsCovered: true,
      accountsCleared: 1,
      monthlyInterest: '$69.00',
      approved: true,
    },
  },

  /**
   * 03. Credit impact: high, medium, low -> A, B, loan. Identical order to APR here, so the
   *     plan matches scenario 01 exactly. That equivalence is the point.
   */
  {
    id: '03-credit-impact',
    title: 'Credit impact ordering coincides with rate ordering here',
    guards: 'That the impact weights sort high > medium > low.',
    state: THREE_DEBTS,
    snapshot: THREE_DEBTS_BALANCES,
    asOf: DAY,
    strategy: 'credit-impact',
    expect: {
      fundsAvailable: '$2,000.00',
      payments: { a: '$1,775.00', b: '$25.00', l: '$200.00' },
      totalAllocated: '$2,000.00',
      leftOver: '$0.00',
      closing: { a: '$225.00', b: '$775.00', l: '$9,800.00' },
      minimumsCovered: true,
      accountsCleared: 0,
      monthlyInterest: '$65.13',
      approved: true,
    },
  },

  /**
   * 04. Largest balance first: loan $10,000, A $2,000, B $800.
   *   L = $200.00 + $1,725.00 = $1,925.00, leaving $8,075.00
   *   A = $50.00                          leaving $1,950.00
   *   B = $25.00                          leaving $775.00
   *   interest: $8,075.00 x .005 = $40.375 -> $40.38
   *             $1,950.00 x .02  = $39.00
   *               $775.00 x .015 = $11.625 -> $11.63
   *   total = $91.01, the most expensive of the four. That is the honest answer, not a bug.
   */
  {
    id: '04-highest-balance',
    title: 'Chasing the largest balance is the costliest option',
    guards: 'Rounding half-away-from-zero on two separate fractions in one total.',
    state: THREE_DEBTS,
    snapshot: THREE_DEBTS_BALANCES,
    asOf: DAY,
    strategy: 'highest-balance',
    expect: {
      fundsAvailable: '$2,000.00',
      payments: { l: '$1,925.00', a: '$50.00', b: '$25.00' },
      totalAllocated: '$2,000.00',
      leftOver: '$0.00',
      closing: { l: '$8,075.00', a: '$1,950.00', b: '$775.00' },
      minimumsCovered: true,
      accountsCleared: 0,
      monthlyInterest: '$91.01',
      approved: true,
    },
  },

  /**
   * 05. Two payoff opportunities in one plan.
   *   checking $2,000.00, cushion $500.00 -> funds $1,500.00
   *   A $1,200.00 20% min $40.00; B $300.00 15% min $20.00
   *   minimums $60.00, left to order $1,440.00
   *   A = $40.00 + $1,160.00 = $1,200.00, cleared, $280.00 still spare
   *   B = $20.00 + $280.00   = $300.00,   cleared
   *   both at zero, so no interest accrues at all
   */
  {
    id: '05-double-payoff',
    title: 'Money reaching far enough clears two accounts outright',
    guards: 'That allocation stops exactly at a zero balance and moves on, twice in a row.',
    state: state([
      cash('chk', 'Checking', '500.00'),
      debt('a', 'Card A', 0.2, '40.00', 'high'),
      debt('b', 'Card B', 0.15, '20.00', 'medium'),
    ]),
    snapshot: snapshot(DAY, { chk: '2000.00', a: '1200.00', b: '300.00' }),
    asOf: DAY,
    strategy: 'avalanche',
    expect: {
      fundsAvailable: '$1,500.00',
      payments: { a: '$1,200.00', b: '$300.00' },
      totalAllocated: '$1,500.00',
      leftOver: '$0.00',
      closing: { a: '$0.00', b: '$0.00' },
      minimumsCovered: true,
      accountsCleared: 2,
      monthlyInterest: '$0.00',
      approved: true,
    },
  },

  /**
   * 06. Not enough to cover the minimums.
   *   checking $1,200.00, cushion $1,000.00 -> funds $200.00, against $275.00 of minimums
   *   paid in avalanche order so the shortfall lands on the loan, ranked last:
   *     A $50.00, B $25.00, loan $125.00 of its $200.00 -> $75.00 short
   *   interest: $1,950.00 x .02 = $39.00; $775.00 x .015 -> $11.63; $9,875.00 x .005 = $49.375 -> $49.38
   *   total = $100.01
   *   Validation must reject: a missed contractual minimum is a hard stop.
   */
  {
    id: '06-minimums-short',
    title: 'A shortfall falls on the least urgent debt and is rejected',
    guards: 'That minimums are never silently skipped, and the shortfall is placed deliberately.',
    state: THREE_DEBTS,
    snapshot: snapshot(DAY, { chk: '1200.00', a: '2000.00', b: '800.00', l: '10000.00' }),
    asOf: DAY,
    strategy: 'avalanche',
    expect: {
      fundsAvailable: '$200.00',
      payments: { a: '$50.00', b: '$25.00', l: '$125.00' },
      totalAllocated: '$200.00',
      leftOver: '$0.00',
      closing: { a: '$1,950.00', b: '$775.00', l: '$9,875.00' },
      minimumsCovered: false,
      accountsCleared: 0,
      monthlyInterest: '$100.01',
      approved: false,
      failedRules: ['MINIMUMS_COVERED'],
    },
  },

  /**
   * 07. Balance exactly on the cushion: nothing is available at all.
   *   checking $1,000.00, cushion $1,000.00 -> funds $0.00
   *   interest on the untouched card: $2,000.00 x .02 = $40.00
   */
  {
    id: '07-no-funds',
    title: 'Sitting exactly on the cushion frees nothing',
    guards: 'That a zero budget produces zero payments rather than a negative or a crash.',
    state: state([cash('chk', 'Checking', '1000.00'), debt('a', 'Card A', 0.24, '50.00', 'high')]),
    snapshot: snapshot(DAY, { chk: '1000.00', a: '2000.00' }),
    asOf: DAY,
    strategy: 'avalanche',
    expect: {
      fundsAvailable: '$0.00',
      payments: { a: '$0.00' },
      totalAllocated: '$0.00',
      leftOver: '$0.00',
      closing: { a: '$2,000.00' },
      minimumsCovered: false,
      accountsCleared: 0,
      monthlyInterest: '$40.00',
      approved: false,
      failedRules: ['MINIMUMS_COVERED'],
    },
  },

  /**
   * 08. More money than debt.
   *   checking $20,000.00, cushion $1,000.00 -> funds $19,000.00
   *   total debt $2,800.00, so $16,200.00 must stay in cash rather than be overpaid.
   */
  {
    id: '08-surplus',
    title: 'Surplus stays in cash instead of overpaying',
    guards: 'That the plan never pays an account into credit just because funds remain.',
    state: state([
      cash('chk', 'Checking', '1000.00'),
      debt('a', 'Card A', 0.24, '50.00', 'high'),
      debt('b', 'Card B', 0.18, '25.00', 'medium'),
    ]),
    snapshot: snapshot(DAY, { chk: '20000.00', a: '2000.00', b: '800.00' }),
    asOf: DAY,
    strategy: 'avalanche',
    expect: {
      fundsAvailable: '$19,000.00',
      payments: { a: '$2,000.00', b: '$800.00' },
      totalAllocated: '$2,800.00',
      leftOver: '$16,200.00',
      closing: { a: '$0.00', b: '$0.00' },
      minimumsCovered: true,
      accountsCleared: 2,
      monthlyInterest: '$0.00',
      approved: true,
    },
  },

  /**
   * 09. One debt only.
   *   checking $5,000.00, cushion $1,000.00 -> funds $4,000.00
   *   A $1,500.00 cleared, $2,500.00 left over
   */
  {
    id: '09-single-debt',
    title: 'A single debt is cleared and the rest left alone',
    guards: 'Degenerate case: ranking a list of one.',
    state: state([cash('chk', 'Checking', '1000.00'), debt('a', 'Card A', 0.22, '60.00', 'high')]),
    snapshot: snapshot(DAY, { chk: '5000.00', a: '1500.00' }),
    asOf: DAY,
    strategy: 'avalanche',
    expect: {
      fundsAvailable: '$4,000.00',
      payments: { a: '$1,500.00' },
      totalAllocated: '$1,500.00',
      leftOver: '$2,500.00',
      closing: { a: '$0.00' },
      minimumsCovered: true,
      accountsCleared: 1,
      monthlyInterest: '$0.00',
      approved: true,
    },
  },

  /**
   * 10. Identical APRs, so the tie is broken by balance, largest first.
   *   checking $2,000.00, cushion $0.00 -> funds $2,000.00
   *   X $1,000.00 and Y $600.00, both 18%, both min $30.00
   *   X ranks first on the larger balance; both clear, $400.00 left over.
   */
  {
    id: '10-apr-tie',
    title: 'Equal rates are broken by balance, deterministically',
    guards: 'That ordering is total and reproducible rather than dependent on input order.',
    state: state([
      cash('chk', 'Checking', '0.00'),
      debt('x', 'Card X', 0.18, '30.00', 'low'),
      debt('y', 'Card Y', 0.18, '30.00', 'low'),
    ]),
    snapshot: snapshot(DAY, { chk: '2000.00', x: '1000.00', y: '600.00' }),
    asOf: DAY,
    strategy: 'avalanche',
    expect: {
      fundsAvailable: '$2,000.00',
      payments: { x: '$1,000.00', y: '$600.00' },
      totalAllocated: '$1,600.00',
      leftOver: '$400.00',
      closing: { x: '$0.00', y: '$0.00' },
      minimumsCovered: true,
      accountsCleared: 2,
      monthlyInterest: '$0.00',
      approved: true,
    },
  },

  /**
   * 11. The plan lands exactly on the cushion.
   *   checking $2,500.00, cushion $500.00 -> funds $2,000.00
   *   A $3,000.00 receives $2,000.00, leaving $1,000.00
   *   checking ends at $2,500.00 - $2,000.00 = $500.00, exactly the cushion, which passes.
   *   interest $1,000.00 x .02 = $20.00
   */
  {
    id: '11-cushion-exact',
    title: 'Spending down to the cushion exactly is allowed',
    guards: 'The boundary of the cushion rule: at the line passes, below it does not.',
    state: state([cash('chk', 'Checking', '500.00'), debt('a', 'Card A', 0.24, '100.00', 'high')]),
    snapshot: snapshot(DAY, { chk: '2500.00', a: '3000.00' }),
    asOf: DAY,
    strategy: 'avalanche',
    expect: {
      fundsAvailable: '$2,000.00',
      payments: { a: '$2,000.00' },
      totalAllocated: '$2,000.00',
      leftOver: '$0.00',
      closing: { a: '$1,000.00' },
      minimumsCovered: true,
      accountsCleared: 0,
      monthlyInterest: '$20.00',
      approved: true,
    },
  },

  /**
   * 12. Rent inside the pre-payday window.
   *   as of 2026-03-20 the next payday is 2026-04-15, and rent of $1,200.00 falls 2026-04-01.
   *   funds = $3,000.00 - $1,000.00 cushion - $1,200.00 rent = $800.00
   *   minimums $75.00, left to order $725.00
   *   A = $50.00 + $725.00 = $775.00, leaving $1,225.00;  B = $25.00, leaving $775.00
   *   interest: $1,225.00 x .02 = $24.50; $775.00 x .015 = $11.625 -> $11.63; total $36.13
   */
  {
    id: '12-rent-in-window',
    title: 'Rent due before payday shrinks the budget',
    guards: 'The commitment window, and that the cushion still survives alongside it.',
    state: state(
      [
        cash('chk', 'Checking', '1000.00'),
        debt('a', 'Card A', 0.24, '50.00', 'high'),
        debt('b', 'Card B', 0.18, '25.00', 'medium'),
      ],
      [rent('1200.00', 1)],
    ),
    snapshot: snapshot(DAY, { chk: '3000.00', a: '2000.00', b: '800.00' }),
    asOf: '2026-03-20' as IsoDate,
    strategy: 'avalanche',
    expect: {
      fundsAvailable: '$800.00',
      payments: { a: '$775.00', b: '$25.00' },
      totalAllocated: '$800.00',
      leftOver: '$0.00',
      closing: { a: '$1,225.00', b: '$775.00' },
      minimumsCovered: true,
      accountsCleared: 0,
      monthlyInterest: '$36.13',
      approved: true,
    },
  },

  /**
   * 13. An already-cleared card is not ranked at all.
   *   checking $2,000.00, cushion $0.00 -> funds $2,000.00
   *   A is at $0.00 so it is excluded entirely; B $500.00 clears; $1,500.00 left over.
   *   A's $50.00 minimum is not "missed": nothing is owed, so nothing is due.
   */
  {
    id: '13-zero-balance-excluded',
    title: 'An account at zero is left out of the plan entirely',
    guards: 'That a paid-off card is not handed a payment, nor counted as a missed minimum.',
    state: state([
      cash('chk', 'Checking', '0.00'),
      debt('a', 'Card A', 0.24, '50.00', 'high'),
      debt('b', 'Card B', 0.18, '25.00', 'medium'),
    ]),
    snapshot: snapshot(DAY, { chk: '2000.00', a: '0.00', b: '500.00' }),
    asOf: DAY,
    strategy: 'avalanche',
    expect: {
      fundsAvailable: '$2,000.00',
      payments: { b: '$500.00' },
      totalAllocated: '$500.00',
      leftOver: '$1,500.00',
      closing: { b: '$0.00' },
      minimumsCovered: true,
      accountsCleared: 1,
      monthlyInterest: '$0.00',
      approved: true,
    },
  },

  /**
   * 14. The contractual minimum is larger than the balance.
   *   A owes $30.00 but its minimum is $50.00. The minimum is capped at what is owed, so the
   *   payment is $30.00 and the card clears. Asking for $50.00 would be paying into credit.
   */
  {
    id: '14-minimum-capped',
    title: 'A minimum larger than the balance is capped at the balance',
    guards: 'That a nearly-cleared card is never asked for more than it owes.',
    state: state([cash('chk', 'Checking', '0.00'), debt('a', 'Card A', 0.24, '50.00', 'high')]),
    snapshot: snapshot(DAY, { chk: '1000.00', a: '30.00' }),
    asOf: DAY,
    strategy: 'avalanche',
    expect: {
      fundsAvailable: '$1,000.00',
      payments: { a: '$30.00' },
      totalAllocated: '$30.00',
      leftOver: '$970.00',
      closing: { a: '$0.00' },
      minimumsCovered: true,
      accountsCleared: 1,
      monthlyInterest: '$0.00',
      approved: true,
    },
  },

  /**
   * 15. Cent-level conservation across an amount that does not divide evenly.
   *   checking $1,000.01, cushion $0.00 -> funds $1,000.01
   *   three cards at $333.33, $333.33 and $333.35, minimums $10.00 each
   *   ordered by APR 10% / 9% / 8%, all three clear:
   *     $333.33 + $333.33 + $333.35 = $1,000.01, to the cent, nothing left over
   */
  {
    id: '15-cent-conservation',
    title: 'An awkward total is conserved to the cent',
    guards: 'That integer cents survive a three-way split with no rounding drift.',
    state: state([
      cash('chk', 'Checking', '0.00'),
      debt('p', 'Card P', 0.1, '10.00', 'medium'),
      debt('q', 'Card Q', 0.09, '10.00', 'medium'),
      debt('r', 'Card R', 0.08, '10.00', 'medium'),
    ]),
    snapshot: snapshot(DAY, { chk: '1000.01', p: '333.33', q: '333.33', r: '333.35' }),
    asOf: DAY,
    strategy: 'avalanche',
    expect: {
      fundsAvailable: '$1,000.01',
      payments: { p: '$333.33', q: '$333.33', r: '$333.35' },
      totalAllocated: '$1,000.01',
      leftOver: '$0.00',
      closing: { p: '$0.00', q: '$0.00', r: '$0.00' },
      minimumsCovered: true,
      accountsCleared: 3,
      monthlyInterest: '$0.00',
      approved: true,
    },
  },

  /**
   * 16. Large balances, where a float would already have drifted.
   *   checking $50,000.00, cushion $5,000.00 -> funds $45,000.00
   *   N $35,000.00 at 19.99% min $450.00; M $120,000.00 at 7.25% min $900.00
   *   minimums $1,350.00, left to order $43,650.00
   *   N = $450.00 + $34,550.00 = $35,000.00, cleared, $9,100.00 still spare
   *   M = $900.00 + $9,100.00  = $10,000.00, leaving $110,000.00
   *   interest on M: $110,000.00 x 7.25% / 12 = 11,000,000c x 0.00604166... = 66,458.33c -> $664.58
   */
  {
    id: '16-large-balances',
    title: 'Six-figure balances stay exact',
    guards: 'Integer-cent arithmetic at a magnitude where binary floats visibly drift.',
    state: state([
      cash('chk', 'Checking', '5000.00'),
      debt('n', 'Card N', 0.1999, '450.00', 'high'),
      debt('m', 'Mortgage', 0.0725, '900.00', 'low'),
    ]),
    snapshot: snapshot(DAY, { chk: '50000.00', n: '35000.00', m: '120000.00' }),
    asOf: DAY,
    strategy: 'avalanche',
    expect: {
      fundsAvailable: '$45,000.00',
      payments: { n: '$35,000.00', m: '$10,000.00' },
      totalAllocated: '$45,000.00',
      leftOver: '$0.00',
      closing: { n: '$0.00', m: '$110,000.00' },
      minimumsCovered: true,
      accountsCleared: 1,
      monthlyInterest: '$664.58',
      approved: true,
    },
  },

  /**
   * 17. The budget clears everything with nothing to spare.
   *   checking $1,500.00, cushion $0.00 -> funds $1,500.00
   *   P $1,000.00 at 15% and Q $500.00 at 10% both clear, total exactly $1,500.00
   */
  {
    id: '17-exact-clearance',
    title: 'The budget clears the whole position exactly',
    guards: 'The boundary where leftover is zero and every account reaches zero together.',
    state: state([
      cash('chk', 'Checking', '0.00'),
      debt('p', 'Card P', 0.15, '50.00', 'high'),
      debt('q', 'Card Q', 0.1, '25.00', 'medium'),
    ]),
    snapshot: snapshot(DAY, { chk: '1500.00', p: '1000.00', q: '500.00' }),
    asOf: DAY,
    strategy: 'avalanche',
    expect: {
      fundsAvailable: '$1,500.00',
      payments: { p: '$1,000.00', q: '$500.00' },
      totalAllocated: '$1,500.00',
      leftOver: '$0.00',
      closing: { p: '$0.00', q: '$0.00' },
      minimumsCovered: true,
      accountsCleared: 2,
      monthlyInterest: '$0.00',
      approved: true,
    },
  },

  /**
   * 18. A small, very expensive debt outranks a large cheap one.
   *   checking $1,000.00, cushion $0.00 -> funds $1,000.00
   *   small $200.00 at 29.99% min $25.00; big $8,000.00 at 4.5% min $100.00
   *   minimums $125.00, left to order $875.00
   *   small = $25.00 + $175.00 = $200.00, cleared, $700.00 spare
   *   big   = $100.00 + $700.00 = $800.00, leaving $7,200.00
   *   interest: $7,200.00 x 4.5% / 12 = 720,000c x 0.00375 = 2,700c = $27.00
   */
  {
    id: '18-small-expensive-first',
    title: 'A small high-rate debt outranks a large cheap one',
    guards: 'That ranking follows rate, not size, under the avalanche.',
    state: state([
      cash('chk', 'Checking', '0.00'),
      debt('small', 'Store Card', 0.2999, '25.00', 'high'),
      debt('big', 'Student Loan', 0.045, '100.00', 'low'),
    ]),
    snapshot: snapshot(DAY, { chk: '1000.00', small: '200.00', big: '8000.00' }),
    asOf: DAY,
    strategy: 'avalanche',
    expect: {
      fundsAvailable: '$1,000.00',
      payments: { small: '$200.00', big: '$800.00' },
      totalAllocated: '$1,000.00',
      leftOver: '$0.00',
      closing: { small: '$0.00', big: '$7,200.00' },
      minimumsCovered: true,
      accountsCleared: 1,
      monthlyInterest: '$27.00',
      approved: true,
    },
  },

  /**
   * 19. A position that is already underwater.
   *   checking $500.00, cushion $0.00, rent $600.00 due 2026-04-01, inside the window from 03-20
   *   funds = $500.00 - $0.00 - $600.00 = -$100.00, clamped to $0.00
   *   No payment is possible, and validation must reject on every count: the money is not there,
   *   the minimum is missed, rent cannot clear, and checking would go negative.
   */
  {
    id: '19-underwater',
    title: 'An underwater position is rejected on every relevant rule',
    guards: 'That a negative budget clamps to zero and every affected rule reports, not just one.',
    state: state(
      [cash('chk', 'Checking', '0.00'), debt('a', 'Card A', 0.2, '50.00', 'high')],
      [rent('600.00', 1)],
    ),
    snapshot: snapshot(DAY, { chk: '500.00', a: '1000.00' }),
    asOf: '2026-03-20' as IsoDate,
    strategy: 'avalanche',
    expect: {
      fundsAvailable: '$0.00',
      payments: { a: '$0.00' },
      totalAllocated: '$0.00',
      leftOver: '$0.00',
      closing: { a: '$1,000.00' },
      minimumsCovered: false,
      accountsCleared: 0,
      monthlyInterest: '$16.67',
      approved: false,
      failedRules: [
        'WITHIN_AVAILABLE_FUNDS',
        'MINIMUMS_COVERED',
        'CUSHION_MAINTAINED',
        'COMMITMENTS_COVERED',
        'CASH_NOT_NEGATIVE',
      ],
    },
  },

  /**
   * 20. A hand-edited plan that overpays.
   *   The generated plan clears A with $1,000.00. The user edits it to $1,500.00, which would
   *   pay the card $500.00 into credit. The funds are there, the cushion survives, so only the
   *   overpayment rule catches it — which is exactly why that rule exists separately.
   *   Interest below is for the generated plan, which clears A: $0.00.
   */
  {
    id: '20-manual-overpay',
    title: 'A hand-edited overpayment is caught on its own rule',
    guards: 'That validation stands on its own against an edited plan, not just a generated one.',
    state: state([cash('chk', 'Checking', '0.00'), debt('a', 'Card A', 0.2, '50.00', 'high')]),
    snapshot: snapshot(DAY, { chk: '5000.00', a: '1000.00' }),
    asOf: DAY,
    strategy: 'avalanche',
    manualPayments: { a: '1500.00' },
    expect: {
      fundsAvailable: '$5,000.00',
      payments: { a: '$1,000.00' },
      totalAllocated: '$1,000.00',
      leftOver: '$4,000.00',
      closing: { a: '$0.00' },
      minimumsCovered: true,
      accountsCleared: 1,
      monthlyInterest: '$0.00',
      approved: false,
      failedRules: ['NO_OVERPAYMENT'],
    },
  },
];
