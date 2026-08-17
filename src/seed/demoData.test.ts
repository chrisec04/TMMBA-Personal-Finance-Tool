import { describe, expect, it } from 'vitest';
import { assertWellFormed, balanceOf } from '../domain/accounts.ts';
import { compareIsoDates, daysInMonth, nextDayOfMonth, parseIsoDate, type IsoDate } from '../domain/dates.ts';
import { parseMoney } from '../domain/money.ts';
import { buildDemoState, DEMO_NARRATIVE, DEMO_REFERENCE_DATE, DEMO_STATE } from './demoData.ts';

describe('DEMO_STATE', () => {
  it('is structurally well formed', () => {
    expect(() => assertWellFormed(DEMO_STATE)).not.toThrow();
  });

  it('has eight complete month-end snapshots', () => {
    expectCompleteHistory(DEMO_STATE, DEMO_REFERENCE_DATE);
  });

  it('stores every money value as integer cents', () => {
    expectIntegerMoney(DEMO_STATE);
  });

  it('contains exactly the checking cushion breach described in the narrative', () => {
    const checking = DEMO_STATE.accounts.find((account) => account.id === DEMO_STATE.primaryCashAccountId);
    if (checking === undefined || checking.kind !== 'cash') throw new Error('demo checking account missing');

    const breaches = DEMO_STATE.history.filter((snapshot) => {
      const balance = balanceOf(snapshot, checking.id);
      if (balance === undefined) throw new Error(`missing checking balance on ${snapshot.date}`);
      return balance < checking.cushion;
    });
    const breach = DEMO_STATE.history[2];
    if (breach === undefined) throw new Error('demo breach snapshot missing');

    expect(DEMO_NARRATIVE).toContain('third month');
    expect(DEMO_NARRATIVE).not.toContain(breach.date);
    expect(breaches.map((snapshot) => snapshot.date)).toEqual([breach.date]);
    expect(balanceOf(breach, checking.id)).toBe(parseMoney('940.00'));
  });

  it('builds a current eight-month story for different reference dates', () => {
    for (const referenceDate of [
      '2024-02-29',
      '2026-08-16',
      '2026-08-31',
      '2027-01-03',
    ] as const) {
      const state = buildDemoState(referenceDate);
      expect(() => assertWellFormed(state)).not.toThrow();
      expectCompleteHistory(state, referenceDate);
      expectIntegerMoney(state);
      expectBreachAtThirdSnapshot(state);
    }
  });

  it('keeps rent inside the pre-payday window for part of the month', () => {
    const afterPayday = '2026-08-16' as IsoDate;
    const nextRent = nextDayOfMonth(afterPayday, 1);
    const nextPayday = nextDayOfMonth(afterPayday, DEMO_STATE.paydayOfMonth);

    expect(compareIsoDates(nextRent, nextPayday)).toBeLessThan(0);
  });
});

function expectCompleteHistory(state: typeof DEMO_STATE, referenceDate: IsoDate): void {
  expect(state.history).toHaveLength(8);

  state.history.forEach((snapshot, index) => {
    const { year, month, day } = parseIsoDate(snapshot.date);

    // The first seven are month-ends. The last is the reference date itself, so the demo always
    // opens with current figures rather than a staleness warning.
    if (index < state.history.length - 1) {
      expect(day, snapshot.date).toBe(daysInMonth(year, month));
    } else {
      expect(snapshot.date).toBe(referenceDate);
    }

    expect(compareIsoDates(snapshot.date, referenceDate), snapshot.date).toBeLessThanOrEqual(0);
    for (const account of state.accounts) {
      expect(balanceOf(snapshot, account.id), `${snapshot.date} ${account.name}`).toBeDefined();
    }
  });

  // Dates must be strictly increasing, or the trend series would double-count a month.
  const dates = state.history.map((snapshot) => snapshot.date);
  expect([...dates].sort(compareIsoDates)).toEqual(dates);
  expect(new Set(dates).size).toBe(dates.length);
}

function expectIntegerMoney(state: typeof DEMO_STATE): void {
  for (const account of state.accounts) {
    if (account.kind === 'cash') expect(Number.isInteger(account.cushion)).toBe(true);
    if (account.kind === 'liability') {
      expect(Number.isInteger(account.minimumPayment)).toBe(true);
      if (account.creditLimit !== undefined) expect(Number.isInteger(account.creditLimit)).toBe(true);
    }
  }
  for (const commitment of state.commitments) {
    expect(Number.isInteger(commitment.amount)).toBe(true);
  }
  for (const snapshot of state.history) {
    for (const value of Object.values(snapshot.balances)) {
      expect(Number.isInteger(value)).toBe(true);
    }
  }
}

function expectBreachAtThirdSnapshot(state: typeof DEMO_STATE): void {
  const checking = state.accounts.find((account) => account.id === state.primaryCashAccountId);
  if (checking === undefined || checking.kind !== 'cash') throw new Error('demo checking account missing');
  const breach = state.history[2];
  if (breach === undefined) throw new Error('demo breach snapshot missing');

  const breaches = state.history.filter((snapshot) => {
    const balance = balanceOf(snapshot, checking.id);
    if (balance === undefined) throw new Error(`missing checking balance on ${snapshot.date}`);
    return balance < checking.cushion;
  });

  expect(breaches.map((snapshot) => snapshot.date)).toEqual([breach.date]);
}
