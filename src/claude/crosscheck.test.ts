/**
 * Cross-check tests.
 *
 * The claim this project makes is that a wrong number from the model cannot reach the user as
 * fact. That claim lives or dies here, so these tests are written as attacks: each one is a way
 * a plausible-sounding reply could be wrong, and each must be caught.
 */

import { describe, expect, it } from 'vitest';
import { parseMoney } from '../domain/money.ts';
import { buildPlan } from '../domain/allocation.ts';
import { STATE, SNAPSHOT, CARD_A, CARD_B, LOAN } from '../domain/__fixtures__/state.ts';
import { crossCheck, unexplainedFigures } from './crosscheck.ts';
import { extractJson, parseAnalysis } from './schema.ts';
import { ClaudeError } from './ClaudePort.ts';
import { recordedAnalysisFor } from './StubClaude.ts';
import type { Analysis } from './schema.ts';

/** Card A $1,775.00, Card B $25.00, Loan $200.00. */
const PLAN = buildPlan(STATE, SNAPSHOT, parseMoney('2000.00'), 'avalanche');
const IDS = PLAN.payments.map((p) => p.accountId);

function analysis(notes: Analysis['debtNotes'], summary = 'A summary.'): Analysis {
  return { summary, debtNotes: notes, tradeoffs: [], watchOuts: [] };
}

describe('crossCheck', () => {
  it('passes a reply that quotes the right figure', () => {
    const result = crossCheck(
      analysis([{ accountId: CARD_A, note: 'Highest rate.', citedPayment: '1775.00' }]),
      PLAN,
    );

    expect(result.trustworthy).toBe(true);
    expect(result.discrepancies).toEqual([]);
    expect(result.caveat).toBeNull();
  });

  /**
   * The core case. A model that says "$1,700.00" where the engine says "$1,775.00" must not have
   * that number silently corrected, and must not have it displayed as fact either.
   */
  it('catches a quoted figure that does not match the calculation', () => {
    const result = crossCheck(
      analysis([{ accountId: CARD_A, note: 'Highest rate.', citedPayment: '1700.00' }]),
      PLAN,
    );

    expect(result.trustworthy).toBe(false);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]).toMatchObject({
      accountName: 'Card A',
      claimed: '$1,700.00',
      actual: '$1,775.00',
      difference: '+$75.00',
    });
  });

  /** A single cent of drift is still a discrepancy. There is no tolerance band. */
  it('catches an error of one cent', () => {
    const result = crossCheck(
      analysis([{ accountId: CARD_A, note: 'x', citedPayment: '1775.01' }]),
      PLAN,
    );
    expect(result.trustworthy).toBe(false);
    expect(result.discrepancies[0]?.difference).toBe('-$0.01');
  });

  it('reports every mismatch, not just the first', () => {
    const result = crossCheck(
      analysis([
        { accountId: CARD_A, note: 'x', citedPayment: '1.00' },
        { accountId: CARD_B, note: 'y', citedPayment: '2.00' },
        { accountId: LOAN, note: 'z', citedPayment: '200.00' },
      ]),
      PLAN,
    );

    expect(result.discrepancies.map((d) => d.accountName)).toEqual(['Card A', 'Card B']);
    expect(result.caveat).toContain('2 figure(s)');
  });

  it('treats an unparseable figure as a discrepancy rather than crashing', () => {
    const result = crossCheck(
      analysis([{ accountId: CARD_A, note: 'x', citedPayment: 'about seventeen hundred' }]),
      PLAN,
    );

    expect(result.trustworthy).toBe(false);
    expect(result.discrepancies[0]?.difference).toBe('not a readable amount');
  });

  it('is satisfied by a reply that quotes nothing at all', () => {
    const result = crossCheck(analysis([{ accountId: CARD_A, note: 'Highest rate.' }]), PLAN);
    expect(result.trustworthy).toBe(true);
  });

  /** Commentary returned out of order would read as disagreement about priority. */
  it('reorders notes to match the plan ranking', () => {
    const result = crossCheck(
      analysis([
        { accountId: LOAN, note: 'third' },
        { accountId: CARD_A, note: 'first' },
        { accountId: CARD_B, note: 'second' },
      ]),
      PLAN,
    );

    expect(result.notesInPlanOrder.map((n) => n.accountId)).toEqual([CARD_A, CARD_B, LOAN]);
  });

  it('keeps the commentary even when it is untrustworthy', () => {
    const result = crossCheck(
      analysis([{ accountId: CARD_A, note: 'Still worth reading.', citedPayment: '1.00' }]),
      PLAN,
    );

    expect(result.analysis.debtNotes[0]?.note).toBe('Still worth reading.');
    expect(result.caveat).toContain('are the calculated ones and are correct');
  });
});

describe('unexplainedFigures', () => {
  it('says nothing when the prose only uses figures from the plan', () => {
    const found = unexplainedFigures(
      analysis([], 'You are putting $1,775.00 against Card A, leaving $225.00.'),
      PLAN,
    );
    expect(found).toEqual([]);
  });

  /** A confident figure the engine never produced is exactly what to surface. */
  it('flags a figure that appears nowhere in the plan', () => {
    const found = unexplainedFigures(
      analysis([], 'This saves you roughly $4,120.00 over the next two years.'),
      PLAN,
    );
    expect(found).toEqual(['$4,120.00']);
  });
});

describe('parseAnalysis', () => {
  it('accepts a well-formed reply', () => {
    const parsed = parseAnalysis(
      { summary: 's', debtNotes: [{ accountId: CARD_A, note: 'n' }], tradeoffs: ['t'], watchOuts: [] },
      IDS,
    );
    expect(parsed.summary).toBe('s');
    expect(parsed.debtNotes).toHaveLength(1);
  });

  /** A hallucinated account is the failure mode this check exists for. */
  it('rejects a note about an account that does not exist', () => {
    expect(() =>
      parseAnalysis(
        { summary: 's', debtNotes: [{ accountId: 'imaginary-card', note: 'n' }] },
        IDS,
      ),
    ).toThrow(ClaudeError);
  });

  it('rejects a reply that is not an object', () => {
    expect(() => parseAnalysis('sorry, I cannot help with that', IDS)).toThrow(ClaudeError);
  });

  it('rejects a missing summary', () => {
    expect(() => parseAnalysis({ debtNotes: [] }, IDS)).toThrow(ClaudeError);
  });

  it('defaults the optional arrays rather than failing', () => {
    const parsed = parseAnalysis({ summary: 's' }, IDS);
    expect(parsed.debtNotes).toEqual([]);
    expect(parsed.tradeoffs).toEqual([]);
  });
});

describe('extractJson', () => {
  it('reads a bare object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('reads an object out of a fenced block', () => {
    expect(extractJson('Here you go:\n```json\n{"a":1}\n```\nHope that helps.')).toEqual({ a: 1 });
  });

  it('reads an object out of surrounding prose', () => {
    expect(extractJson('Sure! {"a":1} Let me know.')).toEqual({ a: 1 });
  });

  it('throws when there is no object at all', () => {
    expect(() => extractJson('I am afraid I cannot do that.')).toThrow(ClaudeError);
  });

  it('throws on malformed JSON', () => {
    expect(() => extractJson('{"a": }')).toThrow(ClaudeError);
  });
});

describe('the recorded stub', () => {
  /**
   * The recording is generated from the plan, so it must survive its own cross-check. If it did
   * not, the keyless demo would open on a discrepancy warning and teach the wrong lesson.
   */
  it('produces a reply that passes parsing and cross-checking', () => {
    const parsed = parseAnalysis(extractJson(recordedAnalysisFor(PLAN)), IDS);
    const checked = crossCheck(parsed, PLAN);

    expect(checked.trustworthy).toBe(true);
    expect(checked.notesInPlanOrder).toHaveLength(3);
  });

  it('says plainly that it is a recording', () => {
    const parsed = parseAnalysis(extractJson(recordedAnalysisFor(PLAN)), IDS);
    expect(parsed.summary.toLowerCase()).toContain('recorded response');
    expect(parsed.watchOuts.join(' ')).toContain('Settings');
  });

  it('quotes no figure the plan does not contain', () => {
    const parsed = parseAnalysis(extractJson(recordedAnalysisFor(PLAN)), IDS);
    expect(unexplainedFigures(parsed, PLAN)).toEqual([]);
  });

  it('copes with an empty plan', () => {
    const empty = buildPlan(STATE, SNAPSHOT, parseMoney('0.00'), 'avalanche');
    const parsed = parseAnalysis(extractJson(recordedAnalysisFor(empty)), IDS);
    expect(crossCheck(parsed, empty).trustworthy).toBe(true);
  });
});
