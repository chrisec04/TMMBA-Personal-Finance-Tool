import type { ReactNode } from 'react';
import { formatMoney, type Cents } from '../domain/money.ts';
import type { Step, Traced } from '../domain/explain.ts';
import type { HealthStatus } from '../domain/health.ts';
import type { AffordabilityConfidence } from '../domain/affordability.ts';

export function Card({ title, children, aside }: { readonly title?: string; readonly children: ReactNode; readonly aside?: ReactNode }): ReactNode {
  return <section className="card">{title === undefined && aside === undefined ? null : <div className="card-head"><h2>{title}</h2>{aside}</div>}{children}</section>;
}

export function Money({ value, signed = false }: { readonly value: Cents | null | undefined; readonly signed?: boolean }): ReactNode {
  return <span className="money">{value === null || value === undefined ? '—' : formatMoney(value, { signed })}</span>;
}

export function StatusPill({ status }: { readonly status: HealthStatus }): ReactNode {
  return <span className={`pill status-${status}`}>{status}</span>;
}

export function ConfidencePill({ level }: { readonly level: AffordabilityConfidence }): ReactNode {
  return <span className={`pill confidence-${level}`}>{level} confidence</span>;
}

export function LatencyBadge({ ms, budget }: { readonly ms: number; readonly budget: number }): ReactNode {
  const ok = ms <= budget;
  return <span className={`pill ${ok ? 'status-good' : 'status-moderate'}`}>{ms}ms / {budget}ms</span>;
}

export function MathTrace({ steps }: { readonly steps: readonly Step[] } | { readonly steps: Traced<unknown>['steps'] }): ReactNode {
  return <details className="math-trace"><summary>Show the math</summary>{steps.length === 0 ? <p className="muted">This value was entered directly.</p> : <ol>{steps.map((step, index) => <li key={`${step.label}-${index}`}><div className="trace-label">{step.label}</div><code>{step.formula} = {step.substitution} = {step.result}</code>{step.inputs.length > 0 ? <dl>{step.inputs.map((input) => <div key={input.name}><dt>{input.name}</dt><dd>{input.value}</dd></div>)}</dl> : null}{step.note === undefined ? null : <p>{step.note}</p>}</li>)}</ol>}</details>;
}

export function Assumptions({ items }: { readonly items: readonly string[] }): ReactNode {
  return <div className="assumptions"><h3>Assumptions</h3><ul>{items.map((item) => <li key={item}>{item}</li>)}</ul></div>;
}

export function EmptyState({ title, children }: { readonly title: string; readonly children: ReactNode }): ReactNode {
  return <div className="empty"><h2>{title}</h2><p>{children}</p></div>;
}

export function ScreenTitle({ title, description, action }: { readonly title: string; readonly description?: string; readonly action?: ReactNode }): ReactNode {
  return <div className="screen-title"><div><h1>{title}</h1>{description === undefined ? null : <p>{description}</p>}</div>{action}</div>;
}
