import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  ZERO,
  add,
  allocateEvenly,
  allocateProportionally,
  cents,
  clampAtZero,
  compare,
  formatMoney,
  fromDollars,
  multiply,
  MoneyError,
  parseMoney,
  parseMoneyOptional,
  subtract,
  sum,
  toDecimalString,
  type Cents,
} from './money.ts';

/** Realistic personal-finance magnitudes, in cents. */
const anyCents = fc.integer({ min: -1_000_000_00, max: 1_000_000_00 }).map((n) => cents(n));

describe('parseMoney', () => {
  it('parses plain decimals', () => {
    expect(parseMoney('10549.88')).toBe(1054988);
    expect(parseMoney('0.00')).toBe(0);
    expect(parseMoney('0.01')).toBe(1);
    expect(parseMoney('7')).toBe(700);
  });

  it('parses awkward real-world amounts exactly', () => {
    // Values chosen to exercise every carry case: trailing zeros, a lone cent, five-figure
    // amounts, and fractions that a float would not represent exactly.
    expect(parseMoney('4821.37')).toBe(482137);
    expect(parseMoney('6500.00')).toBe(650000);
    expect(parseMoney('1749.05')).toBe(174905);
    expect(parseMoney('13602.80')).toBe(1360280);
    expect(parseMoney('205.99')).toBe(20599);
    expect(parseMoney('31480.16')).toBe(3148016);
    expect(parseMoney('960.00')).toBe(96000);
    expect(parseMoney('42.03')).toBe(4203);
  });

  it('accepts symbols, grouping and whitespace', () => {
    expect(parseMoney('$1,234.56')).toBe(123456);
    expect(parseMoney('  $ 1,234.56  ')).toBe(123456);
    expect(parseMoney('12,563.99')).toBe(1256399);
  });

  it('handles both negative notations', () => {
    expect(parseMoney('-1234.56')).toBe(-123456);
    expect(parseMoney('(1,234.56)')).toBe(-123456);
    expect(parseMoney('-$1,234.56')).toBe(-123456);
    // A negative inside parentheses is a double negative.
    expect(parseMoney('(-1.00)')).toBe(100);
  });

  it('rounds beyond two decimals half-away-from-zero', () => {
    expect(parseMoney('1.005')).toBe(101);
    expect(parseMoney('-1.005')).toBe(-101);
    expect(parseMoney('1.004')).toBe(100);
    expect(parseMoney('0.999')).toBe(100);
  });

  it('pads a single decimal place', () => {
    expect(parseMoney('1.5')).toBe(150);
    expect(parseMoney('1.5')).not.toBe(15);
  });

  it('rejects junk rather than silently coercing', () => {
    for (const bad of ['', '   ', 'abc', '1.2.3', '$', '--1', '1,23.00', 'NaN', '1e5']) {
      expect(() => parseMoney(bad), `expected ${JSON.stringify(bad)} to throw`).toThrow(MoneyError);
    }
  });

  it('treats blank input as absent, not zero', () => {
    // A blank balance field means "not entered"; conflating it with $0 would silently
    // report a paid-off card.
    expect(parseMoneyOptional('')).toBeUndefined();
    expect(parseMoneyOptional('   ')).toBeUndefined();
    expect(parseMoneyOptional(null)).toBeUndefined();
    expect(parseMoneyOptional(undefined)).toBeUndefined();
    expect(parseMoneyOptional('0')).toBe(0);
  });
});

describe('float hazards', () => {
  it('avoids the 0.1 + 0.2 problem', () => {
    expect(add(parseMoney('0.1'), parseMoney('0.2'))).toBe(parseMoney('0.3'));
    // Proof the naive float approach really would have been wrong here.
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it('avoids drift when summing many small amounts', () => {
    const dime = parseMoney('0.10');
    const values = Array.from({ length: 1000 }, () => dime);
    expect(sum(values)).toBe(parseMoney('100.00'));

    let floatTotal = 0;
    for (let i = 0; i < 1000; i += 1) floatTotal += 0.1;
    expect(floatTotal).not.toBe(100);
  });

  it('scales dollars without the 1.005 * 100 rounding artefact', () => {
    expect(fromDollars(1.005)).toBe(101);
    expect(Math.round(1.005 * 100)).toBe(100); // the bug this guards against
  });

  it('refuses unsafe magnitudes instead of losing precision', () => {
    expect(() => cents(Number.MAX_SAFE_INTEGER + 10)).toThrow(MoneyError);
    expect(() => cents(1.5)).toThrow(MoneyError);
    expect(() => cents(Number.NaN)).toThrow(MoneyError);
    expect(() => cents(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
  });
});

describe('formatting round-trips', () => {
  it('round-trips through the decimal string form', () => {
    fc.assert(
      fc.property(anyCents, (value) => {
        expect(parseMoney(toDecimalString(value))).toBe(value);
      }),
    );
  });

  it('round-trips through the formatted display form', () => {
    fc.assert(
      fc.property(anyCents, (value) => {
        expect(parseMoney(formatMoney(value))).toBe(value);
      }),
    );
  });

  it('round-trips through accounting notation', () => {
    fc.assert(
      fc.property(anyCents, (value) => {
        expect(parseMoney(formatMoney(value, { accounting: true }))).toBe(value);
      }),
    );
  });

  it('formats the way the spreadsheet reads', () => {
    expect(formatMoney(cents(1054988))).toBe('$10,549.88');
    expect(formatMoney(cents(0))).toBe('$0.00');
    expect(formatMoney(cents(-123456))).toBe('-$1,234.56');
    expect(formatMoney(cents(-123456), { accounting: true })).toBe('($1,234.56)');
    expect(formatMoney(cents(500), { symbol: false })).toBe('5.00');
    expect(formatMoney(cents(500), { signed: true })).toBe('+$5.00');
    expect(formatMoney(cents(5), { grouping: false })).toBe('$0.05');
  });
});

/**
 * Whole dollars without the `.00`.
 *
 * Used by the input fields, where a typed `200` turning itself into `200.00` reads as the box
 * correcting you. The rule is on the value, not on the keystrokes, so it has to still
 * round-trip and it has to leave real cents alone.
 */
describe('trimming whole dollars', () => {
  it('drops the decimals only when there are no cents', () => {
    expect(formatMoney(cents(20000), { trimWholeDollars: true })).toBe('$200');
    expect(formatMoney(cents(20044), { trimWholeDollars: true })).toBe('$200.44');
    expect(formatMoney(cents(20040), { trimWholeDollars: true })).toBe('$200.40');
    expect(formatMoney(cents(0), { trimWholeDollars: true })).toBe('$0');
  });

  it('keeps grouping, symbols, signs and accounting notation intact', () => {
    expect(formatMoney(cents(1250000), { trimWholeDollars: true })).toBe('$12,500');
    expect(formatMoney(cents(20000), { symbol: false, trimWholeDollars: true })).toBe('200');
    expect(formatMoney(cents(20000), { signed: true, trimWholeDollars: true })).toBe('+$200');
    expect(formatMoney(cents(-20000), { trimWholeDollars: true })).toBe('-$200');
    expect(formatMoney(cents(-20000), { accounting: true, trimWholeDollars: true })).toBe(
      '($200)',
    );
  });

  it('still round-trips through the parser', () => {
    fc.assert(
      fc.property(anyCents, (value) => {
        expect(parseMoney(formatMoney(value, { trimWholeDollars: true }))).toBe(value);
      }),
    );
  });

  it('leaves the default alone, so columns keep their decimal points aligned', () => {
    expect(formatMoney(cents(20000))).toBe('$200.00');
  });
});

describe('arithmetic laws', () => {
  it('is associative and commutative under addition', () => {
    fc.assert(
      fc.property(anyCents, anyCents, anyCents, (a, b, c) => {
        expect(add(add(a, b), c)).toBe(add(a, add(b, c)));
        expect(add(a, b)).toBe(add(b, a));
      }),
    );
  });

  it('treats zero as the additive identity', () => {
    fc.assert(
      fc.property(anyCents, (a) => {
        expect(add(a, ZERO)).toBe(a);
        expect(subtract(a, ZERO)).toBe(a);
      }),
    );
  });

  it('makes subtraction the inverse of addition', () => {
    fc.assert(
      fc.property(anyCents, anyCents, (a, b) => {
        expect(subtract(add(a, b), b)).toBe(a);
      }),
    );
  });

  it('keeps sum() equal to a fold of add()', () => {
    fc.assert(
      fc.property(fc.array(anyCents, { maxLength: 50 }), (values) => {
        const folded = values.reduce<Cents>((acc, value) => add(acc, value), ZERO);
        expect(sum(values)).toBe(folded);
      }),
    );
  });

  it('orders values antisymmetrically', () => {
    fc.assert(
      fc.property(anyCents, anyCents, (a, b) => {
        // Object.is avoids -0 !== 0 noise when the comparison is a tie.
        expect(Object.is(compare(a, b), 0)).toBe(Object.is(compare(b, a), 0));
        expect(compare(a, b) + compare(b, a)).toBe(0);
      }),
    );
  });

  it('never returns a negative from clampAtZero', () => {
    fc.assert(
      fc.property(anyCents, (a) => {
        expect(clampAtZero(a)).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it('multiplies to whole cents', () => {
    expect(multiply(cents(10000), 0.2074)).toBe(2074);
    expect(multiply(cents(333), 0.5)).toBe(167); // 166.5 rounds away from zero
    expect(multiply(cents(-333), 0.5)).toBe(-167);
    fc.assert(
      fc.property(anyCents, fc.double({ min: 0, max: 2, noNaN: true }), (value, factor) => {
        expect(Number.isInteger(multiply(value, factor))).toBe(true);
      }),
    );
  });
});

describe('allocation conserves the total', () => {
  it('splits evenly without losing or inventing cents', () => {
    expect(allocateEvenly(parseMoney('10.00'), 3)).toEqual([334, 333, 333]);
    expect(sum(allocateEvenly(parseMoney('10.00'), 3))).toBe(parseMoney('10.00'));
  });

  it('conserves the total for any even split', () => {
    fc.assert(
      fc.property(anyCents, fc.integer({ min: 1, max: 40 }), (total, count) => {
        const parts = allocateEvenly(total, count);
        expect(parts).toHaveLength(count);
        expect(sum(parts)).toBe(total);
      }),
    );
  });

  it('conserves the total for any proportional split', () => {
    fc.assert(
      fc.property(
        anyCents,
        fc.array(fc.integer({ min: 0, max: 10_000 }), { minLength: 1, maxLength: 20 }),
        (total, weights) => {
          const parts = allocateProportionally(total, weights);
          expect(parts).toHaveLength(weights.length);
          expect(sum(parts)).toBe(total);
        },
      ),
    );
  });

  it('falls back to an even split when every weight is zero', () => {
    expect(allocateProportionally(parseMoney('9.00'), [0, 0, 0])).toEqual([300, 300, 300]);
  });

  it('rejects nonsensical inputs', () => {
    expect(() => allocateEvenly(ZERO, 0)).toThrow(MoneyError);
    expect(() => allocateEvenly(ZERO, -1)).toThrow(MoneyError);
    expect(() => allocateProportionally(ZERO, [])).toThrow(MoneyError);
    expect(() => allocateProportionally(ZERO, [-1])).toThrow(MoneyError);
  });
});
