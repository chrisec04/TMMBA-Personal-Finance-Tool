import { useMemo, useState, type ReactNode } from 'react';
import { Line, LineChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { analyzeTrends, type TrendRange } from '../../domain/trends.ts';
import { toDollarsNumber } from '../../domain/money.ts';
import { useAppState } from '../AppState.tsx';
import { Card, ConfidencePill, EmptyState, MathTrace, Money, ScreenTitle } from '../components.tsx';

const RANGES: readonly TrendRange[] = ['1M', '3M', '6M', '1Y', 'YTD', 'All'];

export function TrendsScreen(): ReactNode {
  const { state, asOf } = useAppState();
  const [range, setRange] = useState<TrendRange>('6M');
  const analysis = useMemo(() => analyzeTrends(state.history, state.accounts, range, asOf), [asOf, range, state.accounts, state.history]);
  const rows = analysis.snapshots.map((snapshot, index) => ({
    date: snapshot.date,
    cash: analysis.totalCash.points[index]?.value ?? null,
    debt: analysis.totalDebt.points[index]?.value ?? null,
    worth: analysis.netWorth.points[index]?.value ?? null,
  }));
  const chartRows = rows.map((row) => ({ date: row.date, cash: row.cash === null ? null : toDollarsNumber(row.cash.value), debt: row.debt === null ? null : toDollarsNumber(row.debt.value), worth: row.worth === null ? null : toDollarsNumber(row.worth.value) }));
  const confidence = analysis.netWorth.trend.confidence.value;

  if (state.history.length === 0) return <EmptyState title="No history yet">Trend analysis needs at least one snapshot.</EmptyState>;

  return <>
    <ScreenTitle title="Trends & History" description="Confidence is deterministic and inspectable." action={<select value={range} onChange={(event) => setRange(event.target.value as TrendRange)}>{RANGES.map((item) => <option key={item} value={item}>{item}</option>)}</select>} />
    <Card title="Net worth confidence" aside={<ConfidencePill level={confidence.label} />}><div className="confidence-grid"><span>n: <strong>{confidence.n}</strong></span><span>R²: <strong>{confidence.rSquared === null ? 'undefined' : confidence.rSquared.toFixed(4)}</strong></span><span>Residual CV: <strong>{Number.isFinite(confidence.residualCoefficientOfVariation) ? confidence.residualCoefficientOfVariation.toFixed(4) : 'infinite'}</strong></span></div><MathTrace steps={analysis.netWorth.trend.confidence.steps} /></Card>
    <Card title="Totals over time"><div className="chart-box"><ResponsiveContainer width="100%" height={320}><LineChart data={chartRows}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="date" /><YAxis tickFormatter={(value) => `$${Number(value).toLocaleString()}`} /><Tooltip formatter={(value) => `$${Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 })}`} /><Legend /><Line type="monotone" dataKey="cash" name="Total cash" stroke="#4fb286" strokeWidth={2} dot={false} /><Line type="monotone" dataKey="debt" name="Total debt" stroke="#b25f5f" strokeWidth={2} dot={false} /><Line type="monotone" dataKey="worth" name="Net worth" stroke="#4b6f99" strokeWidth={3} dot={false} /></LineChart></ResponsiveContainer></div></Card>
    <Card title="Raw data"><table><thead><tr><th>Date</th><th className="num">Total cash</th><th className="num">Total debt</th><th className="num">Net worth</th><th>Math</th></tr></thead><tbody>{rows.map((row) => <tr key={row.date}><td>{row.date}</td><td className="num"><Money value={row.cash?.value} /></td><td className="num"><Money value={row.debt?.value} /></td><td className="num"><Money value={row.worth?.value} /></td><td>{row.worth === null ? null : <MathTrace steps={row.worth.steps} />}</td></tr>)}</tbody></table></Card>
  </>;
}
