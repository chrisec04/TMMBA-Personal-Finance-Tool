/**
 * Affordability tests.
 *
 * The case worth reading first is "the same purchase, ten days apart". It is the whole reason
 * this module knows about dates, and the difference between a useful answer and a bounced rent
 * payment.
 */

import { describe, expect, it } from 'vitest';
import { formatMoney, parseMoney } from './money.ts';
import { CHECKING, SAVINGS, STATE, SNAPSHOT, withBalances, withoutBalances } from './__fixtures__/state.ts';
import { AffordabilityError, checkAffordability } from './affordability.ts';

/** Before rent enters the window: next payday 2026-03-15, next rent 2026-04-01. */
const BEFORE_RENT = '2026-03-05';
/** After payday has passed: next payday 2026-04-15, so rent on 2026-04-01 is now inside it. */
const AFTER_PAYDAY = '2026-03-20';

describe('checkAffordability', () => {
  /**
   * $3,000.00 balance − $0.00 committed = $3,000.00
   * $3,000.00 − $1,000.00 cushion       = $2,000.00 available
   * $2,000.00 − $500.00 purchase        = $1,500.00 margin -> affordable
   * projected balance $3,000.00 − $500.00 = $2,500.00
   */
  it('says yes when the purchase clears the cushion comfortably', () => {
    const answer = checkAffordability(STATE, SNAPSHOT, {
      amount: parseMoney('500.00'),
      asOf: BEFORE_RENT,
    });

    expect(answer.affordable).toBe(true);
    expect(formatMoney(answer.availableToSpend)).toBe('$2,000.00');
    expect(formatMoney(answer.projectedBalance)).toBe('$2,500.00');
    expect(formatMoney(answer.cushionShortfall)).toBe('$0.00');
    expect(answer.confidence).toBe('high');
  });

  /**
   * The point of the whole module.
   *
   * On 2026-03-05 rent is not yet in the window, so $1,000.00 is affordable against $2,000.00.
   * On 2026-03-20 the next payday is 2026-04-15 and rent of $1,200.00 falls on 2026-04-01, so
   * only $800.00 is genuinely spendable and the very same purchase is not affordable.
   */
  it('changes its answer once rent enters the window', () => {
    const question = { amount: parseMoney('1000.00') } as const;

    const early = checkAffordability(STATE, SNAPSHOT, { ...question, asOf: BEFORE_RENT });
    expect(early.affordable).toBe(true);
    expect(formatMoney(early.committedTotal)).toBe('$0.00');
    expect(formatMoney(early.availableToSpend)).toBe('$2,000.00');

    const late = checkAffordability(STATE, SNAPSHOT, { ...question, asOf: AFTER_PAYDAY });
    expect(late.affordable).toBe(false);
    expect(formatMoney(late.committedTotal)).toBe('$1,200.00');
    expect(formatMoney(late.availableToSpend)).toBe('$800.00');
    expect(late.nextPayday).toBe('2026-04-15');
  });

  /**
   * $3,000.00 − $1,200.00 rent = $1,800.00
   * $1,800.00 − $1,000.00 cushion = $800.00 available
   * $800.00 − $500.00 = $300.00 margin -> affordable, ending at $1,300.00
   */
  it('reports the commitments it counted and where they land', () => {
    const answer = checkAffordability(STATE, SNAPSHOT, {
      amount: parseMoney('500.00'),
      asOf: AFTER_PAYDAY,
    });

    expect(answer.affordable).toBe(true);
    expect(answer.upcoming.map((u) => u.commitment.name)).toEqual(['Rent']);
    expect(answer.upcoming[0]?.dueDate).toBe('2026-04-01');
    expect(formatMoney(answer.projectedBalance)).toBe('$1,300.00');
  });

  /**
   * A thin margin is still a yes, but a less trustworthy one.
   * Available $800.00, purchase $780.00, margin $20.00. The moderate threshold here is
   * max($780.00 / 10, $50.00) = $78.00, and $20.00 falls inside it.
   */
  it('drops to moderate confidence when the margin is thin', () => {
    const answer = checkAffordability(STATE, SNAPSHOT, {
      amount: parseMoney('780.00'),
      asOf: AFTER_PAYDAY,
    });

    expect(answer.affordable).toBe(true);
    expect(answer.confidence).toBe('moderate');
    expect(answer.assumptions.join(' ')).toContain('one unrecorded charge');
  });

  /** A blank balance is not a zero, and the answer must say it is standing on an assumption. */
  it('drops to low confidence when a balance was never recorded', () => {
    const answer = checkAffordability(STATE, withoutBalances([CHECKING]), {
      amount: parseMoney('10.00'),
      asOf: BEFORE_RENT,
    });

    expect(answer.confidence).toBe('low');
    expect(answer.assumptions.join(' ')).toContain('No balance was recorded');
  });

  /** Spending exactly the available amount is allowed: the cushion is a floor, not a moat. */
  it('treats an exact fit as affordable', () => {
    const answer = checkAffordability(STATE, SNAPSHOT, {
      amount: parseMoney('2000.00'),
      asOf: BEFORE_RENT,
    });

    expect(answer.affordable).toBe(true);
    expect(formatMoney(answer.projectedBalance)).toBe('$1,000.00');
    expect(formatMoney(answer.cushionShortfall)).toBe('$0.00');
  });

  /** One cent past the line is a no, and the shortfall is quantified. */
  it('refuses one cent over the line and says by how much', () => {
    const answer = checkAffordability(STATE, SNAPSHOT, {
      amount: parseMoney('2000.01'),
      asOf: BEFORE_RENT,
    });

    expect(answer.affordable).toBe(false);
    expect(formatMoney(answer.cushionShortfall)).toBe('$0.01');
    expect(answer.reasoning).toContain('$0.01');
  });

  it('can be asked about a different cash account', () => {
    const answer = checkAffordability(STATE, SNAPSHOT, {
      amount: parseMoney('400.00'),
      fromAccountId: SAVINGS,
      asOf: BEFORE_RENT,
    });

    expect(answer.account.id).toBe(SAVINGS);
    expect(formatMoney(answer.availableToSpend)).toBe('$500.00');
    expect(answer.affordable).toBe(true);
  });

  it('refuses to spend from a liability account', () => {
    expect(() =>
      checkAffordability(STATE, SNAPSHOT, {
        amount: parseMoney('10.00'),
        fromAccountId: 'card-a' as never,
        asOf: BEFORE_RENT,
      }),
    ).toThrow(AffordabilityError);
  });

  it('rejects a negative purchase', () => {
    expect(() =>
      checkAffordability(STATE, SNAPSHOT, { amount: parseMoney('-1.00'), asOf: BEFORE_RENT }),
    ).toThrow(AffordabilityError);
  });

  /** An already-breached cushion still gives a usable answer rather than throwing. */
  it('still answers when the cushion is already breached', () => {
    const answer = checkAffordability(STATE, withBalances({ [CHECKING]: '400.00' }), {
      amount: parseMoney('50.00'),
      asOf: BEFORE_RENT,
    });

    expect(answer.affordable).toBe(false);
    expect(formatMoney(answer.availableToSpend)).toBe('-$600.00');
  });

  it('shows the math it used', () => {
    const answer = checkAffordability(STATE, SNAPSHOT, {
      amount: parseMoney('500.00'),
      asOf: BEFORE_RENT,
    });

    const labels = answer.explanation.steps.map((s) => s.label);
    expect(labels).toContain('Available to spend');
    expect(labels).toContain('Margin');
    expect(labels).toContain('Projected balance');
  });
});
