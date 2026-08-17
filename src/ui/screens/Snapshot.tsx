import { useMemo } from 'react';
import { assessHealth } from '../../domain/health.ts';
import { totalDebt, netWorth } from '../../domain/accounts.ts';
import { daysBetween } from '../../domain/dates.ts';
import { useAppState } from '../AppState.tsx';
import { Assumptions, Card, EmptyState, LatencyBadge, MathTrace, Money, ScreenTitle, StatusPill } from '../components.tsx';

const BUDGET_MS = 2000;

export function SnapshotScreen(): React.ReactNode {
  const { state, snapshot, asOf } = useAppState();
  const started = performance.now();
  const report = useMemo(() => snapshot === null ? null : assessHealth(state, snapshot, asOf), [asOf, snapshot, state]);
  const renderMs = Math.round(performance.now() - started);

  if (snapshot === null || report === null) return <EmptyState title="No snapshot yet">Load demo data or connect storage to see a financial snapshot.</EmptyState>;

  return <>
    <ScreenTitle title="Financial Snapshot" description={`Balances dated ${snapshot.date}. ${daysBetween(snapshot.date, asOf)} day(s) since last update.`} action={<LatencyBadge ms={renderMs} budget={BUDGET_MS} />} />
    <div className="hero-strip">
      <div><span>Total cash</span><strong><Money value={report.totalCash.value} /></strong><MathTrace steps={report.totalCash.steps} /></div>
      <div><span>Total debt</span><strong><Money value={totalDebt(state.accounts, snapshot)} /></strong></div>
      <div><span>Net worth</span><strong><Money value={netWorth(state.accounts, snapshot)} /></strong></div>
      <div><span>Overall health</span><strong><StatusPill status={report.overall} /></strong></div>
    </div>
    <Card title="Cash cushion and headroom">
      <table><thead><tr><th>Account</th><th className="num">Balance</th><th className="num">Cushion</th><th className="num">Headroom</th><th>Status</th><th>Math</th></tr></thead><tbody>{report.accounts.map((entry) => <tr key={entry.account.id}><td>{entry.account.name}</td><td className="num"><Money value={entry.balance} /></td><td className="num"><Money value={entry.cushion} /></td><td className="num"><Money value={entry.headroom} /></td><td><StatusPill status={entry.status} /></td><td><MathTrace steps={entry.explanation.steps} /></td></tr>)}</tbody></table>
    </Card>
    <Card title="Balances by account"><table><thead><tr><th>Account</th><th>Type</th><th className="num">Balance</th></tr></thead><tbody>{state.accounts.map((account) => <tr key={account.id}><td>{account.name}</td><td>{account.kind}</td><td className="num"><Money value={snapshot.balances[account.id]} /></td></tr>)}</tbody></table></Card>
    <Assumptions items={report.assumptions} />
  </>;
}
