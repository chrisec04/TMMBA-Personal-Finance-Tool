/**
 * The response contract.
 *
 * Claude is asked for a strict JSON shape, and everything that comes back is parsed and checked
 * before any of it reaches the UI. A model that returns prose, or invents a field, or names an
 * account that does not exist, fails here rather than halfway down a render.
 *
 * Note what the schema does *not* contain: there is no field for a total, a projection, or a
 * recommended amount. The shape itself is the safeguard — a narrative field cannot be mistaken
 * for a figure, and there is nowhere for a computed number to be smuggled in.
 */

import { ClaudeError } from './ClaudePort.ts';

/** A remark about one debt, optionally quoting the payment it refers to. */
export interface DebtNote {
  readonly accountId: string;
  /** Why this debt sits where it does in the ordering. */
  readonly note: string;
  /**
   * A figure Claude chose to quote, as a decimal string.
   *
   * Present only when Claude cited one. It is never displayed as-is: `crosscheck.ts` compares it
   * to the engine's own value and reports a discrepancy if they differ.
   */
  readonly citedPayment?: string;
}

export interface Analysis {
  /** One paragraph on the position and the plan. */
  readonly summary: string;
  readonly debtNotes: readonly DebtNote[];
  /** What is being given up by choosing this ordering. */
  readonly tradeoffs: readonly string[];
  /** Things that would change the advice. */
  readonly watchOuts: readonly string[];
}

/** The JSON shape requested of the model, embedded in the system prompt. */
export const RESPONSE_SHAPE = `{
  "summary": "one paragraph, plain English, no invented figures",
  "debtNotes": [
    { "accountId": "<one of the ids given>", "note": "why it is ranked here", "citedPayment": "optional, decimal string, only if quoting a payment given to you" }
  ],
  "tradeoffs": ["what this ordering gives up"],
  "watchOuts": ["what would change this advice"]
}`;

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new ClaudeError(`${path} should be a string, received ${typeof value}`, 'malformed');
  }
  return value;
}

function asArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new ClaudeError(`${path} should be an array, received ${typeof value}`, 'malformed');
  }
  return value;
}

/**
 * Pulls the JSON object out of a reply.
 *
 * Models sometimes wrap JSON in a fenced block or preface it with a sentence, so the first
 * balanced object is extracted rather than assuming the whole reply parses. Anything else is a
 * malformed response and is treated as one.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new ClaudeError('The reply contained no JSON object.', 'malformed');
  }

  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch (error) {
    throw new ClaudeError(
      `The reply was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      'malformed',
    );
  }
}

/**
 * Validates a parsed reply against the contract.
 *
 * `knownAccountIds` is required rather than optional: a note attached to an account that does not
 * exist is exactly the kind of confident-sounding error this whole layer exists to stop, and it
 * cannot be detected without knowing the real ids.
 */
export function parseAnalysis(value: unknown, knownAccountIds: readonly string[]): Analysis {
  if (typeof value !== 'object' || value === null) {
    throw new ClaudeError('The reply was not an object.', 'malformed');
  }
  const raw = value as Record<string, unknown>;

  const summary = asString(raw['summary'], 'summary');

  const known = new Set(knownAccountIds);
  const debtNotes = asArray(raw['debtNotes'] ?? [], 'debtNotes').map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new ClaudeError(`debtNotes[${index}] is not an object`, 'malformed');
    }
    const note = entry as Record<string, unknown>;
    const accountId = asString(note['accountId'], `debtNotes[${index}].accountId`);
    if (!known.has(accountId)) {
      throw new ClaudeError(
        `debtNotes[${index}] refers to "${accountId}", which is not one of the accounts supplied.`,
        'malformed',
      );
    }
    const cited = note['citedPayment'];
    return {
      accountId,
      note: asString(note['note'], `debtNotes[${index}].note`),
      ...(cited === undefined || cited === null
        ? {}
        : { citedPayment: asString(cited, `debtNotes[${index}].citedPayment`) }),
    } satisfies DebtNote;
  });

  const tradeoffs = asArray(raw['tradeoffs'] ?? [], 'tradeoffs').map((entry, index) =>
    asString(entry, `tradeoffs[${index}]`),
  );
  const watchOuts = asArray(raw['watchOuts'] ?? [], 'watchOuts').map((entry, index) =>
    asString(entry, `watchOuts[${index}]`),
  );

  return { summary, debtNotes, tradeoffs, watchOuts };
}
