/**
 * Demo persona: Maren Vale, a fictional instructional profile.
 *
 * None of these accounts, balances or payment patterns belong to a real person. The figures were
 * invented to make the app's surfaces easy to evaluate in public screenshots.
 *
 * Story:
 * - Maren pays the Aurora Rewards Card down by roughly $500 every month, so debt trends have a
 *   clean high-confidence improvement to discover.
 * - Rainy Day Savings absorbs a late-summer move and then rebuilds, so the chart can show that
 *   a recovered balance is still a noisy trend.
 * - Checking falls below its $1,000 cushion in the third snapshot, creating one deliberate
 *   validation rejection for the demo without tying the story to a stale calendar month.
 * - The auto loan amortises steadily while the student loan barely moves, giving the dashboard a
 *   mix of strong, weak and flat signals.
 */

import { type FinancialState, type AccountId, type Snapshot } from '../domain/accounts.ts';
import { addMonths, daysInMonth, formatIsoDate, parseIsoDate, type IsoDate } from '../domain/dates.ts';
import { parseMoney } from '../domain/money.ts';

const everydayChecking = 'everyday-checking' as AccountId;
const rainyDaySavings = 'rainy-day-savings' as AccountId;
const auroraRewardsCard = 'aurora-rewards-card' as AccountId;
const nimbusCashbackCard = 'nimbus-cashback-card' as AccountId;
const trailheadAutoLoan = 'trailhead-auto-loan' as AccountId;
const summitStudentLoan = 'summit-student-loan' as AccountId;

function snapshot(
  date: IsoDate,
  checking: string,
  savings: string,
  aurora: string,
  nimbus: string,
  auto: string,
  student: string,
  note: string,
): Snapshot {
  return {
    date,
    note,
    balances: {
      [everydayChecking]: parseMoney(checking),
      [rainyDaySavings]: parseMoney(savings),
      [auroraRewardsCard]: parseMoney(aurora),
      [nimbusCashbackCard]: parseMoney(nimbus),
      [trailheadAutoLoan]: parseMoney(auto),
      [summitStudentLoan]: parseMoney(student),
    },
  };
}

export const DEMO_NARRATIVE =
  'Maren Vale steadily pays down the Aurora Rewards Card, rebuilds savings after a mid-series dip, briefly breaches the $1,000 checking cushion in the third month of the story, and carries a steadily amortising auto loan plus a nearly flat student loan.';

export const DEMO_REFERENCE_DATE = '2026-08-16' as IsoDate;

export function buildDemoState(referenceDate: IsoDate): FinancialState {
  const dates = storyDates(referenceDate);

  return {
    accounts: [
      {
        id: everydayChecking,
        kind: 'cash',
        name: 'Everyday Checking',
        cushion: parseMoney('1000.00'),
      },
      {
        id: rainyDaySavings,
        kind: 'cash',
        name: 'Rainy Day Savings',
        cushion: parseMoney('0.00'),
      },
      {
        id: auroraRewardsCard,
        kind: 'liability',
        name: 'Aurora Rewards Card',
        apr: 0.2299,
        minimumPayment: parseMoney('120.00'),
        creditLimit: parseMoney('6500.00'),
        creditImpact: 'high',
      },
      {
        id: nimbusCashbackCard,
        kind: 'liability',
        name: 'Nimbus Cashback Card',
        apr: 0.1849,
        minimumPayment: parseMoney('45.00'),
        creditLimit: parseMoney('5000.00'),
        creditImpact: 'medium',
      },
      {
        id: trailheadAutoLoan,
        kind: 'liability',
        name: 'Trailhead Auto Loan',
        apr: 0.069,
        minimumPayment: parseMoney('375.00'),
        creditImpact: 'low',
      },
      {
        id: summitStudentLoan,
        kind: 'liability',
        name: 'Summit Student Loan',
        apr: 0.045,
        minimumPayment: parseMoney('160.00'),
        creditImpact: 'low',
      },
    ],
    commitments: [
      {
        id: 'rent',
        name: 'Rent',
        amount: parseMoney('1850.00'),
        dayOfMonth: 1,
        fundedBy: everydayChecking,
      },
      {
        id: 'streaming',
        name: 'Streaming',
        amount: parseMoney('18.99'),
        dayOfMonth: 12,
        fundedBy: everydayChecking,
      },
      {
        id: 'phone',
        name: 'Phone',
        amount: parseMoney('86.50'),
        dayOfMonth: 9,
        fundedBy: everydayChecking,
      },
      {
        id: 'utilities',
        name: 'Utilities',
        amount: parseMoney('142.75'),
        dayOfMonth: 21,
        fundedBy: everydayChecking,
      },
    ],
    history: [
      snapshot(storyDate(dates, 0), '3150.00', '3200.00', '4200.00', '1450.00', '16400.00', '22850.00', 'Baseline month before the move.'),
      snapshot(storyDate(dates, 1), '2480.00', '2500.00', '3700.00', '1390.00', '16080.00', '22820.00', 'Savings starts covering moving costs.'),
      snapshot(storyDate(dates, 2), '940.00', '1700.00', '3200.00', '1340.00', '15760.00', '22840.00', 'Checking cushion breach after the final moving invoice.'),
      snapshot(storyDate(dates, 3), '3620.00', '2300.00', '2700.00', '1280.00', '15440.00', '22810.00', 'Cash position stabilises after the move.'),
      snapshot(storyDate(dates, 4), '4050.00', '2100.00', '2200.00', '1220.00', '15120.00', '22830.00', 'Holiday travel taps savings, but Aurora payoff continues.'),
      snapshot(storyDate(dates, 5), '4380.00', '2600.00', '1700.00', '1160.00', '14800.00', '22800.00', 'Year-end bonus rebuilds the buffer.'),
      snapshot(storyDate(dates, 6), '4240.00', '3000.00', '1200.00', '1100.00', '14480.00', '22820.00', 'Debt payments continue after annual renewals.'),
      snapshot(storyDate(dates, 7), '4830.00', '3400.00', '700.00', '1040.00', '14160.00', '22790.00', 'Just after payday: Aurora is within reach of being cleared outright.'),
    ],
    paydayOfMonth: 15,
    primaryCashAccountId: everydayChecking,
  };
}

export const DEMO_STATE: FinancialState = buildDemoState(DEMO_REFERENCE_DATE);

/**
 * The eight dates of the story.
 *
 * Seven month-ends plus a check-in on the reference date itself. That last entry matters more
 * than it looks: a demo whose newest figures are always weeks old opens with a staleness warning
 * and reads as neglected, and it would leave the 1M trend range holding a single point, which is
 * not enough to draw a line through. When the reference date *is* a month-end the two coincide,
 * so the story falls back to eight clean month-ends.
 */
function storyDates(referenceDate: IsoDate): readonly IsoDate[] {
  const lastMonthEnd = monthEndOnOrBefore(referenceDate);

  if (lastMonthEnd === referenceDate) {
    return Array.from({ length: 8 }, (_unused, index) => monthEnd(addMonths(lastMonthEnd, index - 7)));
  }

  const earlier = Array.from({ length: 7 }, (_unused, index) =>
    monthEnd(addMonths(lastMonthEnd, index - 6)),
  );
  return [...earlier, referenceDate];
}

function storyDate(dates: readonly IsoDate[], index: number): IsoDate {
  const date = dates[index];
  if (date === undefined) throw new Error(`Missing demo story date ${index}`);
  return date;
}

function monthEndOnOrBefore(referenceDate: IsoDate): IsoDate {
  const { year, month, day } = parseIsoDate(referenceDate);
  if (day === daysInMonth(year, month)) return referenceDate;
  const previous = addMonths(formatIsoDate(year, month, 1), -1);
  return monthEnd(previous);
}

function monthEnd(date: IsoDate): IsoDate {
  const { year, month } = parseIsoDate(date);
  return formatIsoDate(year, month, daysInMonth(year, month));
}
