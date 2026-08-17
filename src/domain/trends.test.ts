import { describe, expect, it } from 'vitest';
import { type Account, type AccountId, type Snapshot } from './accounts.ts';
import { type IsoDate } from './dates.ts';
import { parseMoney } from './money.ts';
import { analyzeTrends, filterSnapshotsByRange, fitTrend, type TrendPoint } from './trends.ts';
import { given } from './explain.ts';

const cash = 'cash' as AccountId;
const debt = 'debt' as AccountId;

const accounts: readonly Account[] = [
  { id: cash, kind: 'cash', name: 'Cash', cushion: parseMoney('0.00') },
  {
    id: debt,
    kind: 'liability',
    name: 'Debt',
    apr: 0.2,
    minimumPayment: parseMoney('25.00'),
    creditImpact: 'high',
  },
];

function point(date: IsoDate, value: string): TrendPoint {
  return { date, value: given(parseMoney(value)) };
}

function snapshot(date: IsoDate, cashBalance: string, debtBalance: string): Snapshot {
  return {
    date,
    balances: {
      [cash]: parseMoney(cashBalance),
      [debt]: parseMoney(debtBalance),
    },
  };
}

describe('fitTrend', () => {
  it('fits a hand-computed perfect monthly least-squares line', () => {
    /*
     * x = [0, 1, 2, 3], y = [$100, $130, $160, $190]
     * meanX = 1.5, meanY = $145
     * numerator = 67.5 + 7.5 + 7.5 + 67.5 = 150 dollar-months
     * denominator = 2.25 + 0.25 + 0.25 + 2.25 = 5 months²
     * slope = $30/month, residuals are all zero, so R² = 1.
     */
    const trend = fitTrend(
      [
        point('2026-01-01', '100.00'),
        point('2026-02-01', '130.00'),
        point('2026-03-01', '160.00'),
        point('2026-04-01', '190.00'),
      ],
      false,
    );

    expect(trend.slopePerMonth.value).toBe(parseMoney('30.00'));
    expect(trend.intercept).toBe(parseMoney('100.00'));
    expect(trend.direction).toBe('improving');
    expect(trend.confidence.value.rSquared).toBeCloseTo(1);
    expect(trend.confidence.value.label).toBe('moderate');
    expect(trend.slopePerMonth.steps.length).toBeGreaterThan(0);
    expect(trend.confidence.steps.length).toBeGreaterThan(0);
  });

  it('fits a hand-computed noisy line and R²', () => {
    /*
     * x = [0, 1, 2, 3], y cents = [10000, 12000, 11900, 13900]
     * meanX = 1.5, meanY = 11950
     * numerator = 5,800; denominator = 5; slope = 1,160 cents/month.
     * intercept = 10,210; residuals = [-210, 630, -630, 210].
     * RSS = 882,000; TSS = 7,610,000; R² = 1 - RSS/TSS = 0.8840998686.
     */
    const trend = fitTrend(
      [
        point('2026-01-01', '100.00'),
        point('2026-02-01', '120.00'),
        point('2026-03-01', '119.00'),
        point('2026-04-01', '139.00'),
      ],
      false,
    );

    expect(trend.slopePerMonth.value).toBe(parseMoney('11.60'));
    expect(trend.intercept).toBe(parseMoney('102.10'));
    expect(trend.confidence.value.rSquared).toBeCloseTo(0.8840998686, 10);
    expect(trend.confidence.value.residualCoefficientOfVariation).toBeCloseTo(0.0392949184, 10);
  });

  it('orients falling debt as improving and falling cash as worsening', () => {
    const falling = [
      point('2026-01-01', '500.00'),
      point('2026-02-01', '400.00'),
      point('2026-03-01', '300.00'),
    ];

    expect(fitTrend(falling, true).direction).toBe('improving');
    expect(fitTrend(falling, false).direction).toBe('worsening');
  });

  it('orients rising net worth as improving', () => {
    const history = [
      snapshot('2026-01-31', '1000.00', '500.00'),
      snapshot('2026-02-28', '1100.00', '400.00'),
      snapshot('2026-03-31', '1200.00', '300.00'),
    ];

    expect(analyzeTrends(history, accounts, 'All', '2026-03-31').netWorth.trend.direction).toBe(
      'improving',
    );
  });

  it('makes each confidence band reachable with exposed inputs', () => {
    const high = fitTrend(
      [
        point('2026-01-01', '100.00'),
        point('2026-02-01', '110.00'),
        point('2026-03-01', '120.00'),
        point('2026-04-01', '130.00'),
        point('2026-05-01', '140.00'),
        point('2026-06-01', '150.00'),
      ],
      false,
    );
    const moderate = fitTrend(
      [
        point('2026-01-01', '80.00'),
        point('2026-02-01', '80.00'),
        point('2026-03-01', '80.00'),
        point('2026-04-01', '90.00'),
      ],
      false,
    );
    const low = fitTrend(
      [
        point('2026-01-01', '100.00'),
        point('2026-02-01', '300.00'),
        point('2026-03-01', '120.00'),
        point('2026-04-01', '280.00'),
        point('2026-05-01', '140.00'),
        point('2026-06-01', '260.00'),
      ],
      false,
    );

    expect(high.confidence.value).toMatchObject({
      label: 'high',
      n: 6,
      rSquared: 1,
      residualCoefficientOfVariation: 0,
    });
    expect(moderate.confidence.value.label).toBe('moderate');
    expect(moderate.confidence.value.n).toBe(4);
    expect(moderate.confidence.value.rSquared).toBeCloseTo(0.6);
    expect(moderate.confidence.value.residualCoefficientOfVariation).toBeCloseTo(0.0331953065);
    expect(low.confidence.value.label).toBe('low');
    expect(low.confidence.value.n).toBe(6);
    expect(low.confidence.value.rSquared).toBeLessThan(0.6);
    expect(low.confidence.value.residualCoefficientOfVariation).toBeGreaterThan(0.25);
  });

  it('keeps exactly three points low even with a perfect line', () => {
    const trend = fitTrend(
      [
        point('2026-01-01', '100.00'),
        point('2026-02-01', '110.00'),
        point('2026-03-01', '120.00'),
      ],
      false,
    );

    expect(trend.confidence.value.n).toBe(3);
    expect(trend.confidence.value.rSquared).toBe(1);
    expect(trend.confidence.value.label).toBe('low');
  });

  it('treats the high-confidence R² threshold as inclusive', () => {
    const justInside = fitTrend(
      [
        point('2026-01-01', '202.43'),
        point('2026-02-01', '210.00'),
        point('2026-03-01', '207.85'),
        point('2026-04-01', '242.15'),
        point('2026-05-01', '240.00'),
        point('2026-06-01', '247.57'),
      ],
      false,
    );
    const justOutside = fitTrend(
      [
        point('2026-01-01', '202.44'),
        point('2026-02-01', '210.00'),
        point('2026-03-01', '207.80'),
        point('2026-04-01', '242.20'),
        point('2026-05-01', '240.00'),
        point('2026-06-01', '247.56'),
      ],
      false,
    );

    expect(justInside.confidence.value.n).toBe(6);
    expect(justInside.confidence.value.rSquared).toBeGreaterThanOrEqual(0.85);
    expect(justInside.confidence.value.rSquared).toBeCloseTo(0.8507308605);
    expect(justInside.confidence.value.residualCoefficientOfVariation).toBeLessThan(0.1);
    expect(justInside.confidence.value.label).toBe('high');
    expect(justOutside.confidence.value.n).toBe(6);
    expect(justOutside.confidence.value.rSquared).toBeLessThan(0.85);
    expect(justOutside.confidence.value.rSquared).toBeCloseTo(0.84968483);
    expect(justOutside.confidence.value.label).toBe('moderate');
  });

  it('guards empty and one-point inputs', () => {
    const empty = fitTrend([], false);
    const one = fitTrend([point('2026-01-01', '100.00')], false);

    expect(empty.direction).toBe('flat');
    expect(empty.confidence.value.label).toBe('low');
    expect(empty.confidence.value.n).toBe(0);
    expect(one.direction).toBe('flat');
    expect(one.confidence.value.label).toBe('low');
    expect(one.confidence.value.n).toBe(1);
  });

  it('handles all-identical values without NaN', () => {
    const trend = fitTrend(
      [
        point('2026-01-01', '250.00'),
        point('2026-02-01', '250.00'),
        point('2026-03-01', '250.00'),
        point('2026-04-01', '250.00'),
        point('2026-05-01', '250.00'),
        point('2026-06-01', '250.00'),
      ],
      false,
    );

    expect(trend.direction).toBe('flat');
    expect(trend.slopePerMonth.value).toBe(parseMoney('0.00'));
    expect(trend.confidence.value.rSquared).toBeNull();
    expect(Number.isNaN(trend.confidence.value.residualCoefficientOfVariation)).toBe(false);
    expect(trend.confidence.value.label).toBe('high');
  });

  it('lowers confidence for noisy residuals', () => {
    const trend = fitTrend(
      [
        point('2026-01-01', '100.00'),
        point('2026-02-01', '300.00'),
        point('2026-03-01', '120.00'),
        point('2026-04-01', '280.00'),
        point('2026-05-01', '140.00'),
        point('2026-06-01', '260.00'),
      ],
      false,
    );

    expect(trend.confidence.value.label).toBe('low');
    expect(trend.confidence.value.residualCoefficientOfVariation).toBeGreaterThan(0.25);
  });
});

describe('range filtering and extraction', () => {
  const history = [
    snapshot('2025-12-31', '1000.00', '500.00'),
    snapshot('2026-01-01', '1100.00', '480.00'),
    snapshot('2026-01-31', '1200.00', '460.00'),
    snapshot('2026-02-28', '1300.00', '440.00'),
    snapshot('2026-03-01', '1400.00', '420.00'),
  ];

  it('includes both range boundaries and excludes future snapshots', () => {
    // Trend windows are closed intervals: a snapshot exactly on `from` or `to` is intentional
    // evidence for that selected range, while anything after `to` belongs to a future report.
    expect(filterSnapshotsByRange(history, '1M', '2026-02-28').map((s) => s.date)).toEqual([
      '2026-01-31',
      '2026-02-28',
    ]);
    expect(filterSnapshotsByRange(history, 'YTD', '2026-02-28').map((s) => s.date)).toEqual([
      '2026-01-01',
      '2026-01-31',
      '2026-02-28',
    ]);
    expect(filterSnapshotsByRange(history, 'All', '2026-02-28').map((s) => s.date)).toEqual([
      '2025-12-31',
      '2026-01-01',
      '2026-01-31',
      '2026-02-28',
    ]);
  });

  it('extracts total and per-account series with traced values', () => {
    const analysis = analyzeTrends(history, accounts, 'All', '2026-02-28');

    expect(analysis.totalCash.points.map((p) => p.value.value)).toEqual([
      parseMoney('1000.00'),
      parseMoney('1100.00'),
      parseMoney('1200.00'),
      parseMoney('1300.00'),
    ]);
    expect(analysis.totalDebt.points.map((p) => p.value.value)).toEqual([
      parseMoney('500.00'),
      parseMoney('480.00'),
      parseMoney('460.00'),
      parseMoney('440.00'),
    ]);
    expect(analysis.netWorth.points.at(-1)?.value.value).toBe(parseMoney('860.00'));
    expect(analysis.accounts).toHaveLength(2);
    expect(analysis.totalDebt.trend.direction).toBe('improving');
    expect(analysis.totalCash.points[0]?.value.steps.length).toBeGreaterThan(0);
  });
});
