import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { recommend } from '../../domain/allocation.ts';
import { parseMoney, formatMoney, type Cents } from '../../domain/money.ts';
import { proposalFromPlan, validate } from '../../domain/validation.ts';
import { useAppState } from '../AppState.tsx';
import { Card, EmptyState, LatencyBadge, Money, ScreenTitle } from '../components.tsx';

const BUDGET_MS = 5000;

export function ValidationScreen(): ReactNode {
  const { state, snapshot, asOf, selectedStrategy } = useAppState();
  const started = performance.now();
  const recommendation = useMemo(
    () => (snapshot === null ? null : recommend(state, snapshot, asOf, selectedStrategy)),
    [asOf, selectedStrategy, snapshot, state],
  );
  const [draft, setDraft] = useState<
    readonly { readonly accountId: string; readonly text: string }[]
  >([]);

  useEffect(() => {
    if (recommendation === null) return;
    setDraft(
      recommendation.primary.payments.map((payment) => ({
        accountId: payment.accountId,
        text: formatMoney(payment.amount, { symbol: false }),
      })),
    );
  }, [recommendation]);

  const parsed = useMemo(
    () =>
      draft.map((entry) => {
        try {
          return { accountId: entry.accountId, amount: parseMoney(entry.text), error: null };
        } catch (cause) {
          return {
            accountId: entry.accountId,
            amount: null,
            error: cause instanceof Error ? cause.message : String(cause),
          };
        }
      }),
    [draft],
  );

  const report = useMemo(() => {
    if (
      snapshot === null ||
      recommendation === null ||
      parsed.some((entry) => entry.amount === null)
    )
      return null;
    const base = proposalFromPlan(recommendation.primary, state.primaryCashAccountId, asOf);
    return validate(state, snapshot, {
      ...base,
      payments: parsed.map((entry) => ({
        accountId: entry.accountId as never,
        amount: entry.amount as Cents,
      })),
    });
  }, [asOf, parsed, recommendation, snapshot, state]);
  const renderMs = Math.round(performance.now() - started);

  if (snapshot === null || recommendation === null)
    return (
      <EmptyState title="No plan yet">
        Generate a recommendation from a snapshot before validating.
      </EmptyState>
    );

  return (
    <>
      <ScreenTitle
        title="Validation & Approval"
        description="Every rule must pass. Failures are hard stops with no override."
        action={<LatencyBadge ms={renderMs} budget={BUDGET_MS} />}
      />
      <Card title="Edit payments before validating">
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th className="num">Recommended</th>
              <th className="num">Edited amount</th>
            </tr>
          </thead>
          <tbody>
            {recommendation.primary.payments.map((payment) => {
              const row = draft.find((entry) => entry.accountId === payment.accountId);
              const parsedRow = parsed.find((entry) => entry.accountId === payment.accountId);
              return (
                <tr key={payment.accountId}>
                  <td>{payment.accountName}</td>
                  <td className="num">
                    <Money value={payment.amount} />
                  </td>
                  <td className="num">
                    <input
                      className="amount-edit"
                      value={row?.text ?? ''}
                      onChange={(event) =>
                        setDraft((current) =>
                          current.map((entry) =>
                            entry.accountId === payment.accountId
                              ? { ...entry, text: event.target.value }
                              : entry,
                          ),
                        )
                      }
                    />
                    {parsedRow?.error === null ? null : (
                      <p className="error-text">Invalid amount</p>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
      {report === null ? (
        <div className="warning-panel">
          Fix the edited payment amounts before validation can run.
        </div>
      ) : (
        <>
          <div className={`verdict ${report.approved ? 'yes' : 'no'}`}>
            <strong>{report.approved ? 'Approved' : 'Rejected'}</strong>
            <p>{report.combination}</p>
          </div>
          <Card title="Rules">
            <table>
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>Result</th>
                  <th>Detail</th>
                  <th>Remedy</th>
                </tr>
              </thead>
              <tbody>
                {report.results.map((rule) => (
                  <tr key={rule.code}>
                    <td>{rule.question}</td>
                    <td>
                      {rule.passed ? (
                        <span className="pill status-good">pass</span>
                      ) : (
                        <span className="pill status-at-risk">fail</span>
                      )}
                    </td>
                    <td>{rule.detail}</td>
                    <td>{rule.passed ? '—' : <strong>{rule.remedy}</strong>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </>
  );
}
