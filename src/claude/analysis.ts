/**
 * The analysis facade.
 *
 * Picks a transport, sends the finished plan, parses the reply, and cross-checks every figure it
 * quoted. The UI calls `analyse` and gets back something already verified, so no screen has to
 * remember to check anything.
 *
 * Failure is a first-class outcome rather than an exception: a missing key, an unreachable API
 * or a malformed reply all produce a result the Recommendation screen can render, because the
 * arithmetic beside it is still perfectly valid and the user should still see it.
 */

import {
  ClaudeError,
  DEFAULT_MODEL,
  isTauri,
  type ClaudePort,
  type KeyStatus,
  type ModelInfo,
} from './ClaudePort.ts';
import { HttpClaude } from './HttpClaude.ts';
import { StubClaude } from './StubClaude.ts';
import { TauriClaude } from './TauriClaude.ts';
import { allowedAccountIds, buildRequest } from './prompt.ts';
import { extractJson, parseAnalysis } from './schema.ts';
import { crossCheck, unexplainedFigures, type CheckedAnalysis } from './crosscheck.ts';
import type { Recommendation } from '../domain/allocation.ts';
import type { HealthReport } from '../domain/health.ts';

export type AnalysisOutcome =
  | {
      readonly kind: 'ok';
      readonly checked: CheckedAnalysis;
      readonly unexplained: readonly string[];
      readonly latencyMs: number;
      readonly fromRecording: boolean;
      readonly model: string | null;
    }
  | {
      readonly kind: 'failed';
      readonly reason: string;
      /** What the user can do about it. */
      readonly remedy: string;
    };

/** The live transport for this environment. Never the stub — that is chosen deliberately. */
export function liveTransport(): ClaudePort {
  return isTauri() ? new TauriClaude() : new HttpClaude();
}

export function recordedTransport(planFor: () => Recommendation | null): ClaudePort {
  return new StubClaude(() => planFor()?.primary ?? null);
}

export interface AnalysisRequest {
  readonly recommendation: Recommendation;
  readonly health: HealthReport | null;
  readonly model: string;
}

function remedyFor(error: ClaudeError): string {
  switch (error.kind) {
    case 'no-key':
      return 'Add an Anthropic API key in Settings to get live commentary. The plan and all its figures are already complete without it.';
    case 'rejected':
      return 'Check the key in Settings. The plan and all its figures are unaffected.';
    case 'malformed':
      return 'Try again. If it keeps happening, the model is not following the response format; the plan and its figures are unaffected either way.';
    case 'network':
      return 'Check your connection and try again. Every figure in the plan was calculated locally and is unaffected.';
  }
}

/**
 * Runs the commentary pass.
 *
 * Nothing here can change a number. The recommendation was computed before this was called and
 * is returned to the UI untouched; all this adds is prose, plus a verdict on how well that prose
 * matches the arithmetic.
 */
export async function analyse(
  port: ClaudePort,
  request: AnalysisRequest,
): Promise<AnalysisOutcome> {
  try {
    const reply = await port.send(buildRequest(request.recommendation, request.health, request.model));
    const parsed = parseAnalysis(
      extractJson(reply.text),
      allowedAccountIds(request.recommendation),
    );
    const checked = crossCheck(parsed, request.recommendation.primary);

    return {
      kind: 'ok',
      checked,
      unexplained: unexplainedFigures(parsed, request.recommendation.primary),
      latencyMs: reply.latencyMs,
      fromRecording: reply.fromRecording,
      model: reply.model ?? null,
    };
  } catch (error) {
    if (error instanceof ClaudeError) {
      return { kind: 'failed', reason: error.message, remedy: remedyFor(error) };
    }
    return {
      kind: 'failed',
      reason: error instanceof Error ? error.message : String(error),
      remedy: 'The plan and all its figures were calculated locally and are unaffected.',
    };
  }
}

export { DEFAULT_MODEL };
export type { KeyStatus, ModelInfo, ClaudePort };
