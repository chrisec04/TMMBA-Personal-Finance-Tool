/**
 * Money as integer cents.
 *
 * Every monetary amount is an integer number of cents. Binary floating point cannot
 * represent most decimal fractions (0.1 + 0.2 === 0.30000000000000004), so dollars are never
 * stored or computed as floats anywhere in this codebase. Conversion to and from a decimal
 * string happens only at the UI/serialisation boundary, through this module.
 *
 * Number.MAX_SAFE_INTEGER is 9,007,199,254,740,991 cents (~$90 trillion), so plain `number`
 * is exact for any realistic personal balance. Operations here assert that invariant rather
 * than assuming it.
 */

declare const CentsBrand: unique symbol;

/** An integer number of cents. Construct only via {@link cents} or {@link parseMoney}. */
export type Cents = number & { readonly [CentsBrand]: 'Cents' };

export const ZERO: Cents = 0 as Cents;

export class MoneyError extends Error {
  override readonly name = 'MoneyError';
}

function assertSafe(n: number, context: string): void {
  if (!Number.isFinite(n)) {
    throw new MoneyError(`${context}: value is not finite (${n})`);
  }
  if (!Number.isSafeInteger(n)) {
    throw new MoneyError(
      `${context}: value ${n} is not a safe integer; money must be whole cents within +/-2^53`,
    );
  }
}

/** Wraps a raw integer count of cents. Throws if it is not a safe integer. */
export function cents(n: number): Cents {
  assertSafe(n, 'cents()');
  return n as Cents;
}

/**
 * Builds Cents from a dollar `number`. Only for literals in tests/fixtures where the
 * source is already a decimal number; production input goes through {@link parseMoney},
 * because a string never lost precision on its way here.
 */
export function fromDollars(dollars: number): Cents {
  if (!Number.isFinite(dollars)) {
    throw new MoneyError(`fromDollars(): value is not finite (${dollars})`);
  }
  // Scale via a string to dodge the classic 1.005 * 100 === 100.49999999999999 problem.
  return parseMoney(dollars.toFixed(4));
}

const MONEY_PATTERN = /^(-)?\$?\s*((?:\d{1,3}(?:,\d{3})*|\d+))(?:\.(\d+))?$/;

/**
 * Parses a human-entered amount into Cents.
 *
 * Accepts an optional `$`, thousands separators, a leading `-`, or parentheses for
 * negatives (accounting style). More than two decimal places are rounded
 * half-away-from-zero, which matches how a person reads "round to the nearest cent" and,
 * unlike JS `Math.round`, treats -0.005 and 0.005 symmetrically.
 */
export function parseMoney(input: string): Cents {
  if (typeof input !== 'string') {
    throw new MoneyError(`parseMoney(): expected a string, received ${typeof input}`);
  }

  let text = input.trim();
  if (text === '') {
    throw new MoneyError('parseMoney(): empty string');
  }

  // Accounting-style negative: (1,234.56)
  let parenthesised = false;
  if (text.startsWith('(') && text.endsWith(')')) {
    parenthesised = true;
    text = text.slice(1, -1).trim();
  }

  const match = MONEY_PATTERN.exec(text);
  if (match === null) {
    throw new MoneyError(`parseMoney(): cannot parse ${JSON.stringify(input)} as an amount`);
  }

  const minus = match[1];
  const wholeRaw = match[2] ?? '';
  const fractionRaw = match[3];
  const negative = parenthesised !== (minus === '-');

  const whole = wholeRaw.replace(/,/g, '');
  const wholeCents = Number(whole) * 100;
  assertSafe(wholeCents, `parseMoney(${JSON.stringify(input)})`);

  let fractionCents = 0;
  if (fractionRaw !== undefined && fractionRaw.length > 0) {
    // Pad/truncate to hundredths, rounding half-away-from-zero on the remainder.
    const hundredths = Number(fractionRaw.slice(0, 2).padEnd(2, '0'));
    const remainder = fractionRaw.slice(2);
    const firstDropped = remainder.length > 0 ? Number(remainder[0]) : 0;
    fractionCents = hundredths + (firstDropped >= 5 ? 1 : 0);
  }

  const total = wholeCents + fractionCents;
  assertSafe(total, `parseMoney(${JSON.stringify(input)})`);
  return (negative ? -total : total) as Cents;
}

/** Parses a value that may legitimately be absent. Blank/undefined/null become undefined. */
export function parseMoneyOptional(input: string | null | undefined): Cents | undefined {
  if (input === null || input === undefined || input.trim() === '') return undefined;
  return parseMoney(input);
}

/** Renders Cents as a plain decimal string with exactly two places, e.g. `-1234.56`. */
export function toDecimalString(value: Cents): string {
  const negative = value < 0;
  const magnitude = Math.abs(value);
  const whole = Math.floor(magnitude / 100);
  const fraction = magnitude % 100;
  return `${negative ? '-' : ''}${whole}.${String(fraction).padStart(2, '0')}`;
}

export interface FormatOptions {
  /** Include a `$`. Default true. */
  readonly symbol?: boolean;
  /** Include thousands separators. Default true. */
  readonly grouping?: boolean;
  /** Render negatives as `(1,234.56)` rather than `-$1,234.56`. Default false. */
  readonly accounting?: boolean;
  /** Always show a leading `+` for positive, non-zero values. Default false. */
  readonly signed?: boolean;
  /**
   * Drop `.00` from whole-dollar amounts. Default false.
   *
   * For fields being typed into, where `200` reformatting itself to `200.00` reads as the box
   * correcting you. Deliberately not the default: money *columns* are read by scanning down
   * them, and mixing `$200` with `$1,234.56` stops the decimal points lining up, which is the
   * one thing tabular figures are for.
   */
  readonly trimWholeDollars?: boolean;
}

/** Formats Cents for display. Display-only; never feed formatted output back into math. */
export function formatMoney(value: Cents, options: FormatOptions = {}): string {
  const symbol = options.symbol ?? true;
  const grouping = options.grouping ?? true;
  const accounting = options.accounting ?? false;
  const signed = options.signed ?? false;
  const trim = options.trimWholeDollars ?? false;

  const negative = value < 0;
  const magnitude = Math.abs(value);
  const whole = Math.floor(magnitude / 100);
  const cents = magnitude % 100;
  const fraction = String(cents).padStart(2, '0');
  const wholeText = grouping ? whole.toLocaleString('en-US') : String(whole);

  // Keyed off the value rather than off what was typed, so it round-trips: whatever produced
  // a whole number of dollars shows as one, and re-formatting never changes the answer.
  const decimals = trim && cents === 0 ? '' : `.${fraction}`;
  const body = `${symbol ? '$' : ''}${wholeText}${decimals}`;

  if (negative) return accounting ? `(${body})` : `-${body}`;
  if (signed && value > 0) return `+${body}`;
  return body;
}

/** Converts to a float. Display and charting only, never for further arithmetic. */
export function toDollarsNumber(value: Cents): number {
  return value / 100;
}

export function add(a: Cents, b: Cents): Cents {
  return cents(a + b);
}

export function subtract(a: Cents, b: Cents): Cents {
  return cents(a - b);
}

export function negate(value: Cents): Cents {
  return cents(-value);
}

export function absolute(value: Cents): Cents {
  return cents(Math.abs(value));
}

export function sum(values: readonly Cents[]): Cents {
  let total = 0;
  for (const value of values) total += value;
  return cents(total);
}

function roundHalfAwayFromZero(n: number): number {
  return n < 0 ? -Math.round(-n) : Math.round(n);
}

/** Multiplies by a real-valued factor, rounding half-away-from-zero to the nearest cent. */
export function multiply(value: Cents, factor: number): Cents {
  if (!Number.isFinite(factor)) {
    throw new MoneyError(`multiply(): factor is not finite (${factor})`);
  }
  return cents(roundHalfAwayFromZero(value * factor));
}

export function isZero(value: Cents): boolean {
  return value === 0;
}

export function isNegative(value: Cents): boolean {
  return value < 0;
}

export function isPositive(value: Cents): boolean {
  return value > 0;
}

export function compare(a: Cents, b: Cents): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function maximum(a: Cents, b: Cents): Cents {
  return a >= b ? a : b;
}

export function minimum(a: Cents, b: Cents): Cents {
  return a <= b ? a : b;
}

/** Clamps a value to be at least zero. Useful for "you cannot pay a negative amount". */
export function clampAtZero(value: Cents): Cents {
  return value < 0 ? ZERO : value;
}

/**
 * Splits an amount into `count` parts that sum back to exactly the original.
 *
 * Naive division loses or invents cents (three ways of $10.00 is not 3 x $3.33). The
 * remainder is handed out one cent at a time across the leading parts so the total is
 * always conserved.
 */
export function allocateEvenly(total: Cents, count: number): Cents[] {
  if (!Number.isInteger(count) || count <= 0) {
    throw new MoneyError(`allocateEvenly(): count must be a positive integer, received ${count}`);
  }
  const sign = total < 0 ? -1 : 1;
  const magnitude = Math.abs(total);
  const base = Math.floor(magnitude / count);
  let remainder = magnitude - base * count;

  const parts: Cents[] = [];
  for (let i = 0; i < count; i += 1) {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    parts.push(cents(sign * (base + extra)));
  }
  return parts;
}

/**
 * Splits an amount in proportion to `weights`, conserving the total exactly.
 *
 * Uses the largest-remainder method: floor every share, then hand the leftover cents to
 * the entries with the biggest truncated fractions. Guarantees `sum(result) === total`.
 */
export function allocateProportionally(total: Cents, weights: readonly number[]): Cents[] {
  if (weights.length === 0) {
    throw new MoneyError('allocateProportionally(): weights must not be empty');
  }
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) {
    throw new MoneyError('allocateProportionally(): weights must be finite and non-negative');
  }

  const weightTotal = weights.reduce((acc, w) => acc + w, 0);
  if (weightTotal === 0) {
    return allocateEvenly(total, weights.length);
  }

  const sign = total < 0 ? -1 : 1;
  const magnitude = Math.abs(total);

  const exact = weights.map((w) => (magnitude * w) / weightTotal);
  const floors = exact.map((value) => Math.floor(value));
  const assigned = floors.reduce((acc, value) => acc + value, 0);
  let leftover = magnitude - assigned;

  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  const result = [...floors];
  for (const entry of order) {
    if (leftover <= 0) break;
    result[entry.index] = (result[entry.index] ?? 0) + 1;
    leftover -= 1;
  }

  return result.map((value) => cents(sign * value));
}
