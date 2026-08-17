import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  compareIsoDates,
  daysBetween,
  daysInMonth,
  formatIsoDate,
  isValidIsoDate,
  monthKey,
  nextDayOfMonth,
  type IsoDate,
} from './dates.ts';

describe('ISO date validation', () => {
  it('accepts real calendar dates and rejects impossible or non-padded dates', () => {
    expect(isValidIsoDate('2024-02-29')).toBe(true);
    expect(isValidIsoDate('2026-02-30')).toBe(false);
    expect(isValidIsoDate('2026-13-01')).toBe(false);
    expect(isValidIsoDate('2026-1-1')).toBe(false);
    expect(isValidIsoDate('')).toBe(false);
    expect(isValidIsoDate('garbage')).toBe(false);
    expect(isValidIsoDate('2026-02-29')).toBe(false);
  });
});

describe('calendar arithmetic', () => {
  it('reports month lengths across ordinary and leap years', () => {
    expect(Array.from({ length: 12 }, (_, index) => daysInMonth(2026, index + 1))).toEqual([
      31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ]);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
  });

  it('clamps month addition to the target month instead of overflowing days', () => {
    expect(addMonths('2026-01-31' as IsoDate, 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31' as IsoDate, 1)).toBe('2024-02-29');
    expect(addMonths('2026-03-31' as IsoDate, -1)).toBe('2026-02-28');
    expect(addMonths('2026-12-31' as IsoDate, 1)).toBe('2027-01-31');
    expect(addMonths('2026-01-31' as IsoDate, -1)).toBe('2025-12-31');
    expect(addMonths('2026-08-31' as IsoDate, 6)).toBe('2027-02-28');
  });

  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-01-31' as IsoDate, 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31' as IsoDate, 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01' as IsoDate, -1)).toBe('2026-02-28');
  });

  it('reports signed whole-day distances including leap days', () => {
    expect(daysBetween('2026-03-05' as IsoDate, '2026-03-10' as IsoDate)).toBe(5);
    expect(daysBetween('2026-03-10' as IsoDate, '2026-03-05' as IsoDate)).toBe(-5);
    expect(daysBetween('2024-02-28' as IsoDate, '2024-03-01' as IsoDate)).toBe(2);
  });

  it('finds the next requested day strictly after the given date', () => {
    expect(nextDayOfMonth('2026-03-01' as IsoDate, 1)).toBe('2026-04-01');
    expect(nextDayOfMonth('2026-02-01' as IsoDate, 31)).toBe('2026-02-28');
    expect(nextDayOfMonth('2026-12-31' as IsoDate, 31)).toBe('2027-01-31');
  });

  it('formats, groups, and orders ISO dates lexicographically', () => {
    expect(monthKey('2026-03-01' as IsoDate)).toBe('2026-03');
    expect(formatIsoDate(2026, 3, 1)).toBe('2026-03-01');
    expect(compareIsoDates('2026-03-01' as IsoDate, '2026-03-02' as IsoDate)).toBe(-1);
    expect(compareIsoDates('2026-03-02' as IsoDate, '2026-03-01' as IsoDate)).toBe(1);
    expect(compareIsoDates('2026-03-01' as IsoDate, '2026-03-01' as IsoDate)).toBe(0);
  });

  it('keeps date-only strings from shifting to the previous local day near midnight UTC', () => {
    const nearMidnight = '2026-03-01' as IsoDate;

    expect(addDays(nearMidnight, 0)).toBe('2026-03-01');
    expect(addMonths(nearMidnight, 0)).toBe('2026-03-01');
    expect(daysBetween(nearMidnight, '2026-03-02' as IsoDate)).toBe(1);
    expect(monthKey(nearMidnight)).toBe('2026-03');
  });
});
