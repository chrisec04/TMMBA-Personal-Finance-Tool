/**
 * Step-by-step math traces.
 *
 * The build brief's first rule is "every number must have visible math", and its load-bearing
 * metric is 100% arithmetic accuracy. Both are easy to honour on the day a function is written
 * and easy to lose six months later, when a new branch quietly returns a number nobody can
 * explain.
 *
 * So explanation is not a convention here, it is the type. A {@link Traced} value carries the
 * result *and* the ordered steps that produced it. A function that computes money returns
 * `Traced<Cents>`, and there is no way to produce one without saying how you got there.
 *
 * Granularity is one step per meaningful operation rather than per individual multiplication:
 * "available after cushion = 2,400.00 - 1,000.00 = 1,400.00" is a step, but decomposing that
 * subtraction into digit operations would bury the reasoning it is supposed to expose.
 */

import { formatMoney, type Cents } from './money.ts';

/** One line of arithmetic, in the form a person would check it. */
export interface Step {
  /** What this step establishes, e.g. "Available after cushion". */
  readonly label: string;
  /** The formula in symbols, e.g. "checking - cushion". */
  readonly formula: string;
  /** The named inputs with their values already rendered for display. */
  readonly inputs: readonly StepInput[];
  /** The formula with values substituted, e.g. "$2,400.00 - $1,000.00". */
  readonly substitution: string;
  /** The rendered result, e.g. "$1,400.00". */
  readonly result: string;
  /** Optional prose for why this step exists at all. */
  readonly note?: string;
}

export interface StepInput {
  readonly name: string;
  readonly value: string;
}

/** A value together with the arithmetic that produced it. */
export interface Traced<T> {
  readonly value: T;
  readonly steps: readonly Step[];
}

/** Wraps a value that needs no derivation, such as a directly entered balance. */
export function given<T>(value: T): Traced<T> {
  return { value, steps: [] };
}

/** Wraps a value with the steps that produced it. */
export function traced<T>(value: T, steps: readonly Step[]): Traced<T> {
  return { value, steps };
}

/**
 * Builds up a calculation, accumulating the steps as it goes.
 *
 * Each `step` call records the arithmetic and returns the value, so the natural way to write
 * the calculation is also the way that records it. Forgetting to explain a number requires
 * deliberately going around this class.
 */
export class Trace {
  private readonly collected: Step[] = [];

  /** Adopts the steps of an already-traced input, so nested derivations stay visible. */
  adopt<T>(input: Traced<T>): T {
    this.collected.push(...input.steps);
    return input.value;
  }

  /** Records a step and returns its result unchanged. */
  step<T>(step: Step, result: T): T {
    this.collected.push(step);
    return result;
  }

  /**
   * Records a money calculation.
   *
   * `inputs` are named so the substitution line reads like the formula with the numbers
   * filled in, which is the form a person can actually check.
   */
  money(
    label: string,
    formula: string,
    inputs: readonly (readonly [string, Cents])[],
    result: Cents,
    note?: string,
  ): Cents {
    return this.step(buildMoneyStep(label, formula, inputs, result, note), result);
  }

  /** Records a non-money calculation, such as a count, a ratio or a percentage. */
  plain(
    label: string,
    formula: string,
    inputs: readonly (readonly [string, string])[],
    result: string,
    note?: string,
  ): void {
    this.step(
      {
        label,
        formula,
        inputs: inputs.map(([name, value]) => ({ name, value })),
        substitution: substitute(formula, inputs),
        result,
        ...(note === undefined ? {} : { note }),
      },
      undefined,
    );
  }

  /** Records a stated assumption or an input taken as given, so it is auditable too. */
  assume(label: string, value: string, note?: string): void {
    this.step(
      {
        label,
        formula: 'given',
        inputs: [],
        substitution: value,
        result: value,
        ...(note === undefined ? {} : { note }),
      },
      undefined,
    );
  }

  /** The steps recorded so far. */
  get steps(): readonly Step[] {
    return [...this.collected];
  }

  /** Packages a result with everything recorded on the way to it. */
  finish<T>(value: T): Traced<T> {
    return { value, steps: this.steps };
  }
}

function buildMoneyStep(
  label: string,
  formula: string,
  inputs: readonly (readonly [string, Cents])[],
  result: Cents,
  note?: string,
): Step {
  const rendered = inputs.map(([name, value]) => [name, formatMoney(value)] as const);
  return {
    label,
    formula,
    inputs: rendered.map(([name, value]) => ({ name, value })),
    substitution: substitute(formula, rendered),
    result: formatMoney(result),
    ...(note === undefined ? {} : { note }),
  };
}

/**
 * Replaces each input name in the formula with its value.
 *
 * Longest name first, so substituting into `checking - checkingCushion` cannot corrupt the
 * longer name by matching the shorter one inside it.
 */
function substitute(formula: string, inputs: readonly (readonly [string, string])[]): string {
  let text = formula;
  const ordered = [...inputs].sort((a, b) => b[0].length - a[0].length);
  for (const [name, value] of ordered) {
    text = text.split(name).join(value);
  }
  return text;
}

/** Renders a trace as plain text, for test failures, logs and copy-to-clipboard. */
export function explain(trace: Traced<unknown>): string {
  if (trace.steps.length === 0) return '(no derivation: value was given)';
  return trace.steps
    .map((step, index) => {
      const head = `${index + 1}. ${step.label}: ${step.formula} = ${step.substitution} = ${step.result}`;
      return step.note === undefined ? head : `${head}\n   ${step.note}`;
    })
    .join('\n');
}
