/**
 * Calendar dates as `YYYY-MM-DD`.
 *
 * A financial date is a calendar date, not an instant. `new Date('2026-03-01')` parses as
 * midnight UTC, so west of Greenwich it renders as the last day of February — which is how a
 * rent payment silently moves into the wrong month. Everything here works on the string, or on
 * UTC components, and never on local time.
 */

export type IsoDate = string & { readonly __isoDate?: never };

const ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidIsoDate(value: string): boolean {
  const match = ISO_PATTERN.exec(value);
  if (match === null) return false;
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function parseIsoDate(value: string): { year: number; month: number; day: number } {
  const match = ISO_PATTERN.exec(value);
  if (match === null) throw new Error(`Not an ISO date: ${JSON.stringify(value)}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function toUtc(value: IsoDate): number {
  const { year, month, day } = parseIsoDate(value);
  return Date.UTC(year, month - 1, day);
}

export function formatIsoDate(year: number, month: number, day: number): IsoDate {
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/** Negative when `a` is earlier. Lexicographic order is chronological for this format. */
export function compareIsoDates(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whole days from `a` to `b`. Negative when `b` is earlier. */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

export function addDays(value: IsoDate, days: number): IsoDate {
  const next = new Date(toUtc(value) + days * 86_400_000);
  return formatIsoDate(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

/** Adds months, clamping the day so 31 Jan + 1 month is the last day of February, not 3 March. */
export function addMonths(value: IsoDate, months: number): IsoDate {
  const { year, month, day } = parseIsoDate(value);
  const zeroBased = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(zeroBased / 12);
  const targetMonth = (zeroBased % 12) + 1;
  return formatIsoDate(targetYear, targetMonth, Math.min(day, daysInMonth(targetYear, targetMonth)));
}

/** `YYYY-MM`, for grouping a series by month. */
export function monthKey(value: IsoDate): string {
  return value.slice(0, 7);
}

/**
 * The next occurrence of a day-of-month, strictly after `from`.
 *
 * Used for "when is rent next due" and "when is the next payday". A day beyond the end of a
 * short month lands on that month's last day, which is how a 31st-of-the-month bill behaves.
 */
export function nextDayOfMonth(from: IsoDate, dayOfMonth: number): IsoDate {
  const { year, month } = parseIsoDate(from);
  const thisMonth = formatIsoDate(year, month, Math.min(dayOfMonth, daysInMonth(year, month)));
  if (compareIsoDates(thisMonth, from) > 0) return thisMonth;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return formatIsoDate(nextYear, nextMonth, Math.min(dayOfMonth, daysInMonth(nextYear, nextMonth)));
}

export function todayIso(now: Date = new Date()): IsoDate {
  return formatIsoDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
}
