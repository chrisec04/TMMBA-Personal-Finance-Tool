/**
 * Account health.
 *
 * The brief names "false snapshot of health" as a top failure mode: a tool that says you are
 * fine while you are one direct debit from an overdraft. The response it asks for is to show
 * the threshold, the projected balance and the assumptions, rather than a bare verdict.
 *
 * So health here is never a lone adjective. Every status comes with the headroom that produced
 * it, the cushion it was measured against, and the arithmetic in between.
 */

import {
  ZERO,
  formatMoney,
  isNegative,
  multiply,
  subtract,
  sum,
  type Cents,
} from './money.ts';
import {
  cashAccounts,
  type CashAccount,
  type FinancialState,
  type Snapshot,
} from './accounts.ts';
import { daysBetween, type IsoDate } from './dates.ts';
import { Trace, type Traced } from './explain.ts';

export type HealthStatus = 'good' | 'moderate' | 'at-risk';

/**
 * How close to the cushion still counts as "moderate".
 *
 * Half the cushion again. The cushion is already the line you do not want to cross, so the
 * warning band is expressed relative to it rather than as a flat dollar figure — a $200 margin
 * means something very different on a $500 cushion than on a $5,000 one.
 */
const MODERATE_BAND_FRACTION = 0.5;

/** How many days before recorded balances are treated as stale enough to mention. */
export const STALE_AFTER_DAYS = 14;

export interface AccountHealth {
  readonly account: CashAccount;
  readonly balance: Cents;
  readonly cushion: Cents;
  /** Balance less cushion. Negative means the cushion is already breached. */
  readonly headroom: Cents;
  readonly status: HealthStatus;
  readonly explanation: Traced<Cents>;
}

export interface HealthReport {
  readonly asOf: IsoDate;
  readonly snapshotDate: IsoDate;
  readonly daysSinceSnapshot: number;
  readonly stale: boolean;
  readonly accounts: readonly AccountHealth[];
  /** The worst status across cash accounts: one at-risk account makes the position at-risk. */
  readonly overall: HealthStatus;
  readonly totalCash: Traced<Cents>;
  readonly totalCushion: Cents;
  readonly assumptions: readonly string[];
}

const SEVERITY: Readonly<Record<HealthStatus, number>> = {
  good: 0,
  moderate: 1,
  'at-risk': 2,
};

function worst(statuses: readonly HealthStatus[]): HealthStatus {
  return statuses.reduce<HealthStatus>(
    (acc, status) => (SEVERITY[status] > SEVERITY[acc] ? status : acc),
    'good',
  );
}

/**
 * Classifies one cash account against its cushion.
 *
 * A zero cushion is not a missing cushion — a savings account can legitimately have none — so
 * the moderate band collapses to nothing and any positive balance is simply good.
 */
export function assessAccount(account: CashAccount, balance: Cents): AccountHealth {
  const trace = new Trace();

  trace.assume(
    `${account.name} cushion`,
    formatMoney(account.cushion),
    'The balance this account is not meant to drop below.',
  );

  const headroom = trace.money(
    `${account.name} headroom`,
    'balance - cushion',
    [
      ['balance', balance],
      ['cushion', account.cushion],
    ],
    subtract(balance, account.cushion),
    'What is genuinely spendable without breaching the cushion.',
  );

  const band = multiply(account.cushion, MODERATE_BAND_FRACTION);
  let status: HealthStatus;
  if (isNegative(headroom)) {
    status = 'at-risk';
  } else if (headroom < band) {
    status = 'moderate';
  } else {
    status = 'good';
  }

  trace.plain(
    `${account.name} status`,
    'headroom vs moderate band',
    [
      ['headroom', formatMoney(headroom)],
      ['moderate band', formatMoney(band)],
    ],
    status,
    `Below zero headroom is at-risk; below ${formatMoney(band)} of headroom is moderate; above it is good.`,
  );

  return {
    account,
    balance,
    cushion: account.cushion,
    headroom,
    status,
    explanation: trace.finish(headroom),
  };
}

/**
 * The whole cash position as of a date.
 *
 * `asOf` is passed in rather than read from the clock, so the same inputs always produce the
 * same report and a test can assert on staleness without waiting a fortnight.
 */
export function assessHealth(
  state: FinancialState,
  snapshot: Snapshot,
  asOf: IsoDate,
): HealthReport {
  const accounts = cashAccounts(state.accounts);
  const assessments = accounts.map((account) =>
    assessAccount(account, snapshot.balances[account.id] ?? ZERO),
  );

  const totalTrace = new Trace();
  const total = totalTrace.money(
    'Total cash',
    accounts.map((a) => a.name).join(' + ') || 'no cash accounts',
    accounts.map((a) => [a.name, snapshot.balances[a.id] ?? ZERO] as const),
    sum(accounts.map((a) => snapshot.balances[a.id] ?? ZERO)),
  );

  const daysSince = daysBetween(snapshot.date, asOf);
  const missing = accounts.filter((a) => snapshot.balances[a.id] === undefined);

  const assumptions: string[] = [
    `Balances are taken from the snapshot dated ${snapshot.date}, ${daysSince} day(s) before ${asOf}.`,
    'Balances are as entered; nothing is retrieved from a bank.',
  ];
  if (daysSince > STALE_AFTER_DAYS) {
    assumptions.push(
      `These balances are more than ${STALE_AFTER_DAYS} days old, so the position may have moved.`,
    );
  }
  if (missing.length > 0) {
    assumptions.push(
      `No balance was recorded for ${missing.map((a) => a.name).join(', ')}; treated as ${formatMoney(ZERO)}, which may understate your position.`,
    );
  }

  return {
    asOf,
    snapshotDate: snapshot.date,
    daysSinceSnapshot: daysSince,
    stale: daysSince > STALE_AFTER_DAYS,
    accounts: assessments,
    overall: worst(assessments.map((a) => a.status)),
    totalCash: totalTrace.finish(total),
    totalCushion: sum(accounts.map((a) => a.cushion)),
    assumptions,
  };
}
