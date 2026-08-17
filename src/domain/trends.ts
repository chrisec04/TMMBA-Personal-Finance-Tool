/**
 * Deterministic trend analysis over financial snapshots.
 *
 * Confidence is deliberately arithmetic, not editorial. A model can summarize the result later,
 * but it never gets to decide whether a noisy line is "high confidence" just because it sounds
 * convincing.
 */

import {
  balanceOf,
  chronological,
  netWorth as snapshotNetWorth,
  totalCash as snapshotTotalCash,
  totalDebt as snapshotTotalDebt,
  type Account,
  type AccountId,
  type Snapshot,
} from './accounts.ts';
import {
  addMonths,
  compareIsoDates,
  daysInMonth,
  formatIsoDate,
  parseIsoDate,
  type IsoDate,
} from './dates.ts';
import { Trace, type Traced } from './explain.ts';
import { ZERO, cents, formatMoney, type Cents } from './money.ts';

export type TrendRange = '1M' | '3M' | '6M' | '1Y' | 'YTD' | 'All';

export type TrendMetric = 'total-cash' | 'total-debt' | 'net-worth' | 'account-balance';

export type TrendDirection = 'improving' | 'worsening' | 'flat';

export type ConfidenceLabel = 'high' | 'moderate' | 'low';

export interface DateRange {
  readonly from?: IsoDate;
  readonly to: IsoDate;
}

export interface TrendPoint {
  readonly date: IsoDate;
  readonly value: Traced<Cents>;
}

export interface ConfidenceBreakdown {
  readonly label: ConfidenceLabel;
  readonly n: number;
  /** `null` means every observed value was identical, so there was no variance to explain. */
  readonly rSquared: number | null;
  /** Root-mean-square residual divided by mean absolute observed value. */
  readonly residualCoefficientOfVariation: number;
}

export interface TrendFit {
  readonly slopePerMonth: Traced<Cents>;
  readonly magnitudePerMonth: Cents;
  readonly direction: TrendDirection;
  readonly confidence: Traced<ConfidenceBreakdown>;
  readonly intercept: Cents;
}

export interface TrendSeries {
  readonly key: string;
  readonly label: string;
  readonly metric: TrendMetric;
  readonly points: readonly TrendPoint[];
  readonly trend: TrendFit;
  readonly accountId?: AccountId;
}

export interface TrendAnalysis {
  readonly range: DateRange;
  readonly snapshots: readonly Snapshot[];
  readonly totalCash: TrendSeries;
  readonly totalDebt: TrendSeries;
  readonly netWorth: TrendSeries;
  readonly accounts: readonly TrendSeries[];
}

export function resolveTrendRange(range: TrendRange, asOf: IsoDate): DateRange {
  switch (range) {
    case '1M':
      return { from: addMonths(asOf, -1), to: asOf };
    case '3M':
      return { from: addMonths(asOf, -3), to: asOf };
    case '6M':
      return { from: addMonths(asOf, -6), to: asOf };
    case '1Y':
      return { from: addMonths(asOf, -12), to: asOf };
    case 'YTD': {
      const { year } = parseIsoDate(asOf);
      return { from: formatIsoDate(year, 1, 1), to: asOf };
    }
    case 'All':
      return { to: asOf };
  }
}

export function filterSnapshotsByRange(
  history: readonly Snapshot[],
  range: TrendRange,
  asOf: IsoDate,
): readonly Snapshot[] {
  const resolved = resolveTrendRange(range, asOf);
  return chronological(history).filter((snapshot) => withinRange(snapshot.date, resolved));
}

export function analyzeTrends(
  snapshots: readonly Snapshot[],
  accounts: readonly Account[],
  range: TrendRange,
  asOf: IsoDate,
): TrendAnalysis {
  const resolved = resolveTrendRange(range, asOf);
  const filtered = chronological(snapshots).filter((snapshot) => withinRange(snapshot.date, resolved));

  return {
    range: resolved,
    snapshots: filtered,
    totalCash: buildTotalSeries(
      'total:cash',
      'Total cash',
      'total-cash',
      filtered,
      accounts,
      false,
      traceTotalCash,
    ),
    totalDebt: buildTotalSeries(
      'total:debt',
      'Total debt',
      'total-debt',
      filtered,
      accounts,
      true,
      traceTotalDebt,
    ),
    netWorth: buildTotalSeries(
      'total:net-worth',
      'Net worth',
      'net-worth',
      filtered,
      accounts,
      false,
      traceNetWorth,
    ),
    accounts: accounts.map((account) => buildAccountSeries(account, filtered)),
  };
}

export function fitTrend(
  points: readonly TrendPoint[],
  liabilityBalance: boolean,
): TrendFit {
  const trace = new Trace();
  const values = points.map((point) => ({ date: point.date, value: trace.adopt(point.value) }));

  if (values.length === 0) {
    const slope = cents(0);
    trace.assume('Trend slope', formatMoney(slope), 'No snapshots are inside this range.');
    return {
      slopePerMonth: trace.finish(slope),
      magnitudePerMonth: cents(0),
      direction: 'flat',
      confidence: confidenceFor([], 0, 0, []),
      intercept: cents(0),
    };
  }

  const first = values[0];
  if (first === undefined) throw new Error('unreachable: non-empty trend has no first point');
  const xs = values.map((point) => monthsBetween(first.date, point.date));
  const ys = values.map((point) => point.value);
  const regression = linearRegression(xs, ys);
  const roundedSlope = roundCents(regression.slope);
  const direction = directionFor(roundedSlope, liabilityBalance);

  trace.plain(
    'Trend slope',
    'Σ((month - meanMonth) × (value - meanValue)) / Σ((month - meanMonth)^2)',
    [
      ['points', String(values.length)],
      ['meanMonth', regression.meanX.toFixed(4)],
      ['meanValue', formatMoney(roundCents(regression.meanY))],
    ],
    `${formatMoney(roundedSlope)} per month`,
    'A least-squares line gives one reproducible monthly pace for the whole selected range.',
  );

  return {
    slopePerMonth: trace.finish(roundedSlope),
    magnitudePerMonth: cents(Math.abs(roundedSlope)),
    direction,
    confidence: confidenceFor(ys, regression.residualSumOfSquares, regression.totalSumOfSquares, regression.residuals),
    intercept: roundCents(regression.intercept),
  };
}

function buildTotalSeries(
  key: string,
  label: string,
  metric: Exclude<TrendMetric, 'account-balance'>,
  snapshots: readonly Snapshot[],
  accounts: readonly Account[],
  liabilityBalance: boolean,
  valueOf: (accounts: readonly Account[], snapshot: Snapshot) => Traced<Cents>,
): TrendSeries {
  const points = snapshots.map((snapshot) => ({ date: snapshot.date, value: valueOf(accounts, snapshot) }));
  return {
    key,
    label,
    metric,
    points,
    trend: fitTrend(points, liabilityBalance),
  };
}

function buildAccountSeries(account: Account, snapshots: readonly Snapshot[]): TrendSeries {
  const points = snapshots.map((snapshot) => ({
    date: snapshot.date,
    value: traceAccountBalance(account, snapshot),
  }));

  return {
    key: `account:${account.id}`,
    label: account.name,
    metric: 'account-balance',
    accountId: account.id,
    points,
    trend: fitTrend(points, account.kind === 'liability'),
  };
}

function traceAccountBalance(account: Account, snapshot: Snapshot): Traced<Cents> {
  const trace = new Trace();
  const value = balanceOf(snapshot, account.id) ?? ZERO;
  trace.assume(
    `${account.name} balance`,
    formatMoney(value),
    'A missing balance is treated as zero here only after model validation has had a chance to reject it.',
  );
  return trace.finish(value);
}

function traceTotalCash(accounts: readonly Account[], snapshot: Snapshot): Traced<Cents> {
  const trace = new Trace();
  const inputs = accounts
    .filter((account) => account.kind === 'cash')
    .map((account) => [account.name, snapshot.balances[account.id] ?? ZERO] as const);
  const total = snapshotTotalCash(accounts, snapshot);
  trace.money('Total cash', formulaFor(inputs, '0'), inputs, total);
  return trace.finish(total);
}

function traceTotalDebt(accounts: readonly Account[], snapshot: Snapshot): Traced<Cents> {
  const trace = new Trace();
  const inputs = accounts
    .filter((account) => account.kind === 'liability')
    .map((account) => [account.name, snapshot.balances[account.id] ?? ZERO] as const);
  const total = snapshotTotalDebt(accounts, snapshot);
  trace.money('Total debt', formulaFor(inputs, '0'), inputs, total);
  return trace.finish(total);
}

function traceNetWorth(accounts: readonly Account[], snapshot: Snapshot): Traced<Cents> {
  const trace = new Trace();
  const cash = trace.adopt(traceTotalCash(accounts, snapshot));
  const debt = trace.adopt(traceTotalDebt(accounts, snapshot));
  const value = snapshotNetWorth(accounts, snapshot);
  trace.money('Net worth', 'cash - debt', [['cash', cash], ['debt', debt]], value);
  return trace.finish(value);
}

function formulaFor(inputs: readonly (readonly [string, Cents])[], empty: string): string {
  if (inputs.length === 0) return empty;
  return inputs.map(([name]) => name).join(' + ');
}

function withinRange(date: IsoDate, range: DateRange): boolean {
  if (compareIsoDates(date, range.to) > 0) return false;
  return range.from === undefined || compareIsoDates(date, range.from) >= 0;
}

function monthsBetween(from: IsoDate, to: IsoDate): number {
  const a = parseIsoDate(from);
  const b = parseIsoDate(to);
  const wholeMonths = (b.year - a.year) * 12 + (b.month - a.month);
  if (a.day === b.day || bothMonthEnds(a.year, a.month, a.day, b.year, b.month, b.day)) {
    return wholeMonths;
  }
  return wholeMonths + (b.day - a.day) / daysInMonth(a.year, a.month);
}

function bothMonthEnds(
  aYear: number,
  aMonth: number,
  aDay: number,
  bYear: number,
  bMonth: number,
  bDay: number,
): boolean {
  return aDay === daysInMonth(aYear, aMonth) && bDay === daysInMonth(bYear, bMonth);
}

interface RegressionResult {
  readonly slope: number;
  readonly intercept: number;
  readonly meanX: number;
  readonly meanY: number;
  readonly residuals: readonly number[];
  readonly residualSumOfSquares: number;
  readonly totalSumOfSquares: number;
}

function linearRegression(xs: readonly number[], ys: readonly Cents[]): RegressionResult {
  if (xs.length !== ys.length) throw new Error('Regression inputs must be the same length');
  if (xs.length === 0) {
    return {
      slope: 0,
      intercept: 0,
      meanX: 0,
      meanY: 0,
      residuals: [],
      residualSumOfSquares: 0,
      totalSumOfSquares: 0,
    };
  }

  const n = xs.length;
  const meanX = xs.reduce((acc, x) => acc + x, 0) / n;
  const meanY = ys.reduce((acc, y) => acc + y, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i += 1) {
    const x = xs[i];
    const y = ys[i];
    if (x === undefined || y === undefined) throw new Error('Regression point is missing');
    numerator += (x - meanX) * (y - meanY);
    denominator += (x - meanX) ** 2;
  }

  const slope = denominator === 0 ? 0 : numerator / denominator;
  const intercept = meanY - slope * meanX;
  const residuals = xs.map((x, index) => {
    const y = ys[index];
    if (y === undefined) throw new Error('Regression point is missing');
    return y - (intercept + slope * x);
  });
  const residualSumOfSquares = sumSquares(residuals);
  const totalSumOfSquares = sumSquares(ys.map((y) => y - meanY));

  return { slope, intercept, meanX, meanY, residuals, residualSumOfSquares, totalSumOfSquares };
}

function confidenceFor(
  values: readonly Cents[],
  residualSumOfSquares: number,
  totalSumOfSquares: number,
  residuals: readonly number[],
): Traced<ConfidenceBreakdown> {
  const trace = new Trace();
  const n = values.length;
  const rSquared = totalSumOfSquares === 0 ? null : 1 - residualSumOfSquares / totalSumOfSquares;
  const goodnessForScoring = rSquared ?? (residualSumOfSquares === 0 ? 1 : 0);
  const meanAbsoluteValue = n === 0 ? 0 : values.reduce((acc, value) => acc + Math.abs(value), 0) / n;
  const rmse = n === 0 ? 0 : Math.sqrt(residualSumOfSquares / n);
  const cv = meanAbsoluteValue === 0 ? (rmse === 0 ? 0 : Number.POSITIVE_INFINITY) : rmse / meanAbsoluteValue;

  /**
   * Thresholds:
   * - Fewer than 3 samples is always low; two points can always draw a line but cannot reveal noise.
   * - High needs at least 6 samples, R² >= 0.85 and residual CV <= 10%.
   * - Moderate needs at least 4 samples, R² >= 0.60 and residual CV <= 25%.
   *
   * Eight month-end demo points should earn high only for a visibly steady story. A quarter-ish
   * of residual noise is still useful as a warning light, but not enough to present as settled.
   * When all values are identical R² is undefined, so the returned value stays `null`; exact
   * residuals score as perfect fit because a flat line is the whole story.
   */
  const label =
    n < 3
      ? 'low'
      : n >= 6 && goodnessForScoring >= 0.85 && cv <= 0.1
        ? 'high'
        : n >= 4 && goodnessForScoring >= 0.6 && cv <= 0.25
          ? 'moderate'
          : 'low';

  trace.plain(
    'Confidence score',
    'samples + residual CV + fit',
    [
      ['samples', String(n)],
      ['residual CV', formatFinite(cv)],
      ['R²', rSquared === null ? 'undefined' : rSquared.toFixed(4)],
    ],
    label,
    'The label is deterministic; the same points always produce the same confidence.',
  );

  if (residuals.length > 0) {
    trace.plain(
      'Residual noise',
      'sqrt(Σ residual² / n) / mean(|value|)',
      [
        ['sqrt(Σ residual² / n)', rmse.toFixed(2)],
        ['mean(|value|)', meanAbsoluteValue.toFixed(2)],
      ],
      formatFinite(cv),
    );
  }

  return trace.finish({
    label,
    n,
    rSquared,
    residualCoefficientOfVariation: cv,
  });
}

function directionFor(slope: Cents, liabilityBalance: boolean): TrendDirection {
  if (slope === 0) return 'flat';
  const improving = liabilityBalance ? slope < 0 : slope > 0;
  return improving ? 'improving' : 'worsening';
}

function roundCents(value: number): Cents {
  return cents(value < 0 ? -Math.round(Math.abs(value)) : Math.round(value));
}

function sumSquares(values: readonly number[]): number {
  return values.reduce((acc, value) => acc + value ** 2, 0);
}

function formatFinite(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4) : 'infinite';
}
