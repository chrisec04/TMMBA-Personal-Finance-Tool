import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  STRATEGIES,
  recommend,
  type AllocationPlan,
  type Recommendation,
} from '../../domain/allocation.ts';
import { assessHealth } from '../../domain/health.ts';
import { analyse, liveTransport, type AnalysisOutcome } from '../../claude/analysis.ts';
import { useAppState } from '../AppState.tsx';
import {
  Assumptions,
  Card,
  EmptyState,
  LatencyBadge,
  MathTrace,
  Money,
  ProvenanceBadge,
  ScreenTitle,
} from '../components.tsx';
import { commentaryStateFor } from '../commentaryState.ts';

const BUDGET_MS = 5000;

function PlanTable({ plan }: { readonly plan: AllocationPlan }): ReactNode {
  return (
    <table>
      <thead>
        <tr>
          <th>Rank</th>
          <th>Account</th>
          <th className="num">Minimum</th>
          <th className="num">Extra</th>
          <th className="num">Payment</th>
          <th className="num">Opening</th>
          <th className="num">Closing</th>
          <th>Marker</th>
        </tr>
      </thead>
      <tbody>
        {plan.payments.map((payment) => (
          <tr key={payment.accountId}>
            <td>{payment.rank}</td>
            <td>
              <strong>{payment.accountName}</strong>
              <p className="muted">{payment.rankReason}</p>
            </td>
            <td className="num">
              <Money value={payment.minimumPortion} />
            </td>
            <td className="num">
              <Money value={payment.extraPortion} />
            </td>
            <td className="num">
              <Money value={payment.amount} />
            </td>
            <td className="num">
              <Money value={payment.openingBalance} />
            </td>
            <td className="num">
              <Money value={payment.closingBalance} />
            </td>
            <td>
              {payment.clearsAccount ? <span className="pill status-good">clears</span> : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StandardCommentary({
  recommendation,
}: {
  readonly recommendation: Recommendation;
}): ReactNode {
  return (
    <div className="standard-explanation">
      <p>{recommendation.whyPrimary}</p>
      <h3>Ranking rationale</h3>
      <ul>
        {recommendation.primary.payments.map((payment) => (
          <li key={payment.accountId}>
            <strong>{payment.accountName}:</strong> {payment.rankReason}
          </li>
        ))}
      </ul>
      <h3>Local assumptions</h3>
      <ul>
        {recommendation.assumptions.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function Commentary({
  recommendation,
  outcome,
  isLoading,
  apiKeyConfigured,
  elapsedMs,
}: {
  readonly recommendation: Recommendation;
  readonly outcome: AnalysisOutcome | null;
  readonly isLoading: boolean;
  readonly apiKeyConfigured: boolean;
  readonly elapsedMs: number;
}): ReactNode {
  const state = commentaryStateFor({ outcome, isLoading, apiKeyConfigured });
  const failed = outcome?.kind === 'failed' ? outcome : null;
  const standard = <StandardCommentary recommendation={recommendation} />;
  if (state.mode !== 'ai') {
    return (
      <div className="commentary">
        <div className="inline-row commentary-head">
          <ProvenanceBadge icon={state.icon} label={state.label} tone={state.tone} />
          {state.mode === 'loading' ? (
            <>
              <span className="spinner" aria-hidden="true" />
              <LatencyBadge ms={elapsedMs} budget={BUDGET_MS} />
            </>
          ) : null}
        </div>
        {state.mode === 'loading' ? (
          <p className="muted">
            Asking Claude for live commentary. The standard explanation remains available, and the
            calculated plan above is not waiting on the network.
          </p>
        ) : null}
        {failed === null ? null : (
          <div className="soft-panel">
            <strong>Live commentary unavailable</strong>
            <p>{failed.reason}</p>
            <p>{failed.remedy}</p>
            <p>The plan and every figure shown above were calculated locally and are unaffected.</p>
          </div>
        )}
        {standard}
      </div>
    );
  }

  if (outcome === null || outcome.kind === 'failed' || outcome.fromRecording) return standard;
  const checked = outcome.checked;
  return (
    <div className="commentary">
      <div className="inline-row commentary-head">
        <ProvenanceBadge icon={state.icon} label={state.label} tone={state.tone} />
        <LatencyBadge ms={outcome.latencyMs} budget={BUDGET_MS} />
      </div>
      {checked.trustworthy ? null : (
        <div className="warning-panel">
          <strong>Commentary caveat</strong>
          <p>{checked.caveat}</p>
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Claimed</th>
                <th>Actual</th>
                <th>Difference</th>
              </tr>
            </thead>
            <tbody>
              {checked.discrepancies.map((d) => (
                <tr key={`${d.accountId}-${d.claimed}`}>
                  <td>{d.accountName}</td>
                  <td>{d.claimed}</td>
                  <td>{d.actual}</td>
                  <td>{d.difference}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p>{checked.analysis.summary}</p>
      <h3>Per-debt notes</h3>
      <ul>
        {checked.notesInPlanOrder.map((note) => (
          <li key={note.accountId}>{note.note}</li>
        ))}
      </ul>
      <h3>Tradeoffs</h3>
      <ul>
        {checked.analysis.tradeoffs.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <h3>Watch-outs</h3>
      <ul>
        {checked.analysis.watchOuts.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      {outcome.unexplained.length === 0 ? null : (
        <div className="soft-panel">
          <strong>Unexplained figures in commentary</strong>
          <p>{outcome.unexplained.join(', ')}</p>
        </div>
      )}
    </div>
  );
}

export function RecommendationScreen(): ReactNode {
  const { state, snapshot, asOf, selectedStrategy, setSelectedStrategy, keyStatus, selectedModel } =
    useAppState();
  const recommendation = useMemo(
    () => (snapshot === null ? null : recommend(state, snapshot, asOf, selectedStrategy)),
    [asOf, selectedStrategy, snapshot, state],
  );
  const health = useMemo(
    () => (snapshot === null ? null : assessHealth(state, snapshot, asOf)),
    [asOf, snapshot, state],
  );
  const port = useMemo(
    () => (keyStatus.configured ? liveTransport() : null),
    [keyStatus.configured],
  );
  const [outcome, setOutcome] = useState<AnalysisOutcome | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const requestId = useRef(0);

  useEffect(() => {
    requestId.current += 1;
    const currentRequest = requestId.current;
    let cancelled = false;
    setOutcome(null);
    setIsLoading(false);
    setStartedAt(null);
    setElapsedMs(0);
    if (recommendation === null || port === null)
      return () => {
        cancelled = true;
      };
    setIsLoading(true);
    setStartedAt(Date.now());
    void analyse(port, { recommendation, health, model: selectedModel })
      .then((result) => {
        if (cancelled || requestId.current !== currentRequest) return;
        setOutcome(result);
        setIsLoading(false);
        setStartedAt(null);
        setElapsedMs(result.kind === 'ok' ? result.latencyMs : 0);
      })
      .catch((cause: unknown) => {
        if (cancelled || requestId.current !== currentRequest) return;
        setOutcome({
          kind: 'failed',
          reason: cause instanceof Error ? cause.message : String(cause),
          remedy: 'The plan and all its figures were calculated locally and are unaffected.',
        });
        setIsLoading(false);
        setStartedAt(null);
      });
    return () => {
      cancelled = true;
    };
  }, [health, port, recommendation, selectedModel]);

  useEffect(() => {
    if (startedAt === null) return;
    const tick = (): void => setElapsedMs(Date.now() - startedAt);
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  if (snapshot === null || recommendation === null)
    return (
      <EmptyState title="No snapshot yet">
        A current snapshot is needed before allocating debt payments.
      </EmptyState>
    );
  const plans = [recommendation.primary, ...recommendation.alternatives];

  return (
    <>
      <ScreenTitle
        title="Debt Allocation"
        description="Local arithmetic chooses the plan; Claude only comments on it."
      />
      <Card
        title="Strategy"
        aside={
          <select
            value={selectedStrategy}
            onChange={(event) => setSelectedStrategy(event.target.value as never)}
          >
            {Object.values(STRATEGIES).map((strategy) => (
              <option key={strategy.id} value={strategy.id}>
                {strategy.name}
              </option>
            ))}
          </select>
        }
      >
        <p>{STRATEGIES[selectedStrategy].rationale}</p>
      </Card>
      <div className="hero-strip">
        <div>
          <span>Funds available</span>
          <strong>
            <Money value={recommendation.fundsAvailable.value} />
          </strong>
          <MathTrace steps={recommendation.fundsAvailable.steps} />
        </div>
        <div>
          <span>Total allocated</span>
          <strong>
            <Money value={recommendation.primary.totalAllocated} />
          </strong>
        </div>
        <div>
          <span>Accounts cleared</span>
          <strong>{recommendation.primary.accountsCleared}</strong>
        </div>
        <div>
          <span>Interest next month</span>
          <strong>
            <Money value={recommendation.primary.projectedMonthlyInterest} />
          </strong>
        </div>
      </div>
      <Card title="Primary plan">
        <p>{recommendation.whyPrimary}</p>
        <PlanTable plan={recommendation.primary} />
        <MathTrace steps={recommendation.primary.explanation.steps} />
      </Card>
      <Card title="Strategy comparison">
        <table>
          <thead>
            <tr>
              <th>Strategy</th>
              <th className="num">Total allocated</th>
              <th className="num">Accounts cleared</th>
              <th className="num">Interest next month</th>
            </tr>
          </thead>
          <tbody>
            {plans.map((plan) => (
              <tr key={plan.strategy.id}>
                <td>
                  <strong>{plan.strategy.name}</strong>
                  <p className="muted">{plan.strategy.rationale}</p>
                </td>
                <td className="num">
                  <Money value={plan.totalAllocated} />
                </td>
                <td className="num">{plan.accountsCleared}</td>
                <td className="num">
                  <Money value={plan.projectedMonthlyInterest} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="Recommendation commentary">
        <Commentary
          recommendation={recommendation}
          outcome={outcome}
          isLoading={isLoading}
          apiKeyConfigured={keyStatus.configured}
          elapsedMs={elapsedMs}
        />
      </Card>
      <Assumptions items={recommendation.assumptions} />
    </>
  );
}
