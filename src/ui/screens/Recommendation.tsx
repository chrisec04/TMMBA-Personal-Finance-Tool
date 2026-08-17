import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { STRATEGIES, recommend, type AllocationPlan } from '../../domain/allocation.ts';
import { assessHealth } from '../../domain/health.ts';
import { analyse, liveTransport, recordedTransport, type AnalysisOutcome } from '../../claude/analysis.ts';
import { useAppState } from '../AppState.tsx';
import { Assumptions, Card, EmptyState, LatencyBadge, MathTrace, Money, ScreenTitle } from '../components.tsx';

const BUDGET_MS = 5000;

function PlanTable({ plan }: { readonly plan: AllocationPlan }): ReactNode {
  return <table><thead><tr><th>Rank</th><th>Account</th><th className="num">Minimum</th><th className="num">Extra</th><th className="num">Payment</th><th className="num">Opening</th><th className="num">Closing</th><th>Marker</th></tr></thead><tbody>{plan.payments.map((payment) => <tr key={payment.accountId}><td>{payment.rank}</td><td><strong>{payment.accountName}</strong><p className="muted">{payment.rankReason}</p></td><td className="num"><Money value={payment.minimumPortion} /></td><td className="num"><Money value={payment.extraPortion} /></td><td className="num"><Money value={payment.amount} /></td><td className="num"><Money value={payment.openingBalance} /></td><td className="num"><Money value={payment.closingBalance} /></td><td>{payment.clearsAccount ? <span className="pill status-good">clears</span> : '—'}</td></tr>)}</tbody></table>;
}

function Commentary({ outcome }: { readonly outcome: AnalysisOutcome | null }): ReactNode {
  if (outcome === null) return <p className="muted">Commentary is loading. The calculated plan is already complete.</p>;
  if (outcome.kind === 'failed') return <div className="warning-panel"><strong>Commentary unavailable</strong><p>{outcome.reason}</p><p>{outcome.remedy}</p><p>The figures above are unaffected.</p></div>;
  const checked = outcome.checked;
  return <div className="commentary">
    <div className="inline-row"><LatencyBadge ms={outcome.latencyMs} budget={BUDGET_MS} />{outcome.fromRecording ? <span className="pill recorded">recorded response — no API key configured</span> : null}{outcome.model === null ? null : <span className="pill">{outcome.model}</span>}</div>
    {checked.trustworthy ? null : <div className="warning-panel"><strong>Commentary caveat</strong><p>{checked.caveat}</p><table><thead><tr><th>Account</th><th>Claimed</th><th>Actual</th><th>Difference</th></tr></thead><tbody>{checked.discrepancies.map((d) => <tr key={`${d.accountId}-${d.claimed}`}><td>{d.accountName}</td><td>{d.claimed}</td><td>{d.actual}</td><td>{d.difference}</td></tr>)}</tbody></table></div>}
    <p>{checked.analysis.summary}</p>
    <h3>Per-debt notes</h3><ul>{checked.notesInPlanOrder.map((note) => <li key={note.accountId}>{note.note}</li>)}</ul>
    <h3>Tradeoffs</h3><ul>{checked.analysis.tradeoffs.map((item) => <li key={item}>{item}</li>)}</ul>
    <h3>Watch-outs</h3><ul>{checked.analysis.watchOuts.map((item) => <li key={item}>{item}</li>)}</ul>
    {outcome.unexplained.length === 0 ? null : <div className="soft-panel"><strong>Unexplained figures in commentary</strong><p>{outcome.unexplained.join(', ')}</p></div>}
  </div>;
}

export function RecommendationScreen(): ReactNode {
  const { state, snapshot, asOf, selectedStrategy, setSelectedStrategy, keyStatus, selectedModel } = useAppState();
  const recommendation = useMemo(() => snapshot === null ? null : recommend(state, snapshot, asOf, selectedStrategy), [asOf, selectedStrategy, snapshot, state]);
  const health = useMemo(() => snapshot === null ? null : assessHealth(state, snapshot, asOf), [asOf, snapshot, state]);
  const port = useMemo(() => (keyStatus.configured ? liveTransport() : recordedTransport(() => recommendation)), [keyStatus, recommendation]);
  const [outcome, setOutcome] = useState<AnalysisOutcome | null>(null);

  useEffect(() => {
    let cancelled = false;
    setOutcome(null);
    if (recommendation === null) return () => { cancelled = true; };
    void analyse(port, { recommendation, health, model: selectedModel }).then((result) => { if (!cancelled) setOutcome(result); });
    return () => { cancelled = true; };
  }, [health, port, recommendation, selectedModel]);

  if (snapshot === null || recommendation === null) return <EmptyState title="No snapshot yet">A current snapshot is needed before allocating debt payments.</EmptyState>;
  const plans = [recommendation.primary, ...recommendation.alternatives];

  return <>
    <ScreenTitle title="Debt Allocation" description="Local arithmetic chooses the plan; Claude only comments on it." />
    <Card title="Strategy" aside={<select value={selectedStrategy} onChange={(event) => setSelectedStrategy(event.target.value as never)}>{Object.values(STRATEGIES).map((strategy) => <option key={strategy.id} value={strategy.id}>{strategy.name}</option>)}</select>}><p>{STRATEGIES[selectedStrategy].rationale}</p></Card>
    <div className="hero-strip"><div><span>Funds available</span><strong><Money value={recommendation.fundsAvailable.value} /></strong><MathTrace steps={recommendation.fundsAvailable.steps} /></div><div><span>Total allocated</span><strong><Money value={recommendation.primary.totalAllocated} /></strong></div><div><span>Accounts cleared</span><strong>{recommendation.primary.accountsCleared}</strong></div><div><span>Interest next month</span><strong><Money value={recommendation.primary.projectedMonthlyInterest} /></strong></div></div>
    <Card title="Primary plan"><p>{recommendation.whyPrimary}</p><PlanTable plan={recommendation.primary} /><MathTrace steps={recommendation.primary.explanation.steps} /></Card>
    <Card title="Strategy comparison"><table><thead><tr><th>Strategy</th><th className="num">Total allocated</th><th className="num">Accounts cleared</th><th className="num">Interest next month</th></tr></thead><tbody>{plans.map((plan) => <tr key={plan.strategy.id}><td><strong>{plan.strategy.name}</strong><p className="muted">{plan.strategy.rationale}</p></td><td className="num"><Money value={plan.totalAllocated} /></td><td className="num">{plan.accountsCleared}</td><td className="num"><Money value={plan.projectedMonthlyInterest} /></td></tr>)}</tbody></table></Card>
    <Card title="Claude commentary"><Commentary outcome={outcome} /></Card>
    <Assumptions items={recommendation.assumptions} />
  </>;
}
