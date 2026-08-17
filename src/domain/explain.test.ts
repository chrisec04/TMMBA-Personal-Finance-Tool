import { describe, expect, it } from 'vitest';
import { explain, given, Trace, traced, type Step } from './explain.ts';
import { parseMoney } from './money.ts';

const suppliedStep: Step = {
  label: 'Supplied',
  formula: 'a + b',
  inputs: [
    { name: 'a', value: '1' },
    { name: 'b', value: '2' },
  ],
  substitution: '1 + 2',
  result: '3',
};

describe('traced values', () => {
  it('treats directly given values as having no derivation', () => {
    expect(given(parseMoney('12.34')).steps).toEqual([]);
  });

  it('carries supplied derivation steps unchanged', () => {
    expect(traced(3, [suppliedStep])).toEqual({ value: 3, steps: [suppliedStep] });
  });
});

describe('Trace', () => {
  it('returns a money result unchanged while recording formatted substitutions', () => {
    const trace = new Trace();
    const result = trace.money(
      'Available',
      'checking - cushion',
      [
        ['checking', parseMoney('2400.00')],
        ['cushion', parseMoney('1000.00')],
      ],
      parseMoney('1400.00'),
    );

    expect(result).toBe(parseMoney('1400.00'));
    expect(trace.steps).toMatchObject([
      {
        label: 'Available',
        substitution: '$2,400.00 - $1,000.00',
        result: '$1,400.00',
      },
    ]);
  });

  it('substitutes longer overlapping input names first', () => {
    const trace = new Trace();

    // Regression guard: replacing "checking" before "checkingCushion" corrupts the second name.
    trace.money(
      'Available after cushion',
      'checking - checkingCushion',
      [
        ['checking', parseMoney('3000.00')],
        ['checkingCushion', parseMoney('1000.00')],
      ],
      parseMoney('2000.00'),
    );

    expect(trace.steps.at(0)?.substitution).toBe('$3,000.00 - $1,000.00');
  });

  it('splices nested traced steps into the parent before later steps', () => {
    const trace = new Trace();
    const nested = traced(parseMoney('25.00'), [suppliedStep]);
    const adopted = trace.adopt(nested);
    trace.assume('Assumed rate', 'fixed');

    expect(adopted).toBe(parseMoney('25.00'));
    expect(trace.steps.map((step) => step.label)).toEqual(['Supplied', 'Assumed rate']);
  });

  it('records plain calculations and assumptions, with assumptions marked as given', () => {
    const trace = new Trace();
    trace.plain('Debt count', 'cards + loans', [['cards', '2'], ['loans', '1']], '3', 'Active debts only.');
    trace.assume('Funding account', 'Checking', 'User selected it.');

    expect(trace.steps).toMatchObject([
      {
        label: 'Debt count',
        substitution: '2 + 1',
        result: '3',
        note: 'Active debts only.',
      },
      {
        label: 'Funding account',
        formula: 'given',
        substitution: 'Checking',
        result: 'Checking',
        note: 'User selected it.',
      },
    ]);
  });

  it('finishes with the value and every recorded step', () => {
    const trace = new Trace();
    trace.assume('Input', 'known');

    expect(trace.finish('done')).toEqual({
      value: 'done',
      steps: trace.steps,
    });
  });

  it('formats zero and negative amounts inside money substitutions', () => {
    const trace = new Trace();
    trace.money(
      'Delta',
      'current - previous',
      [
        ['current', parseMoney('0.00')],
        ['previous', parseMoney('12.34')],
      ],
      parseMoney('-12.34'),
    );

    expect(trace.steps.at(0)?.substitution).toBe('$0.00 - $12.34');
    expect(trace.steps.at(0)?.result).toBe('-$12.34');
  });
});

describe('explain', () => {
  it('renders numbered lines and indented notes when derivation exists', () => {
    const trace = traced('ok', [
      suppliedStep,
      { ...suppliedStep, label: 'With note', note: 'Check this detail.' },
    ]);

    expect(explain(trace)).toBe(
      '1. Supplied: a + b = 1 + 2 = 3\n' +
        '2. With note: a + b = 1 + 2 = 3\n' +
        '   Check this detail.',
    );
  });

  it('says when there is no derivation to render', () => {
    expect(explain(given('input'))).toBe('(no derivation: value was given)');
  });
});
