import { useMemo, useState } from 'react';
import { cashAccounts } from '../../domain/accounts.ts';
import { checkAffordability } from '../../domain/affordability.ts';
import { parseMoney, type Cents } from '../../domain/money.ts';
import { useAppState } from '../AppState.tsx';
import {
  Assumptions,
  Card,
  ConfidencePill,
  EmptyState,
  LatencyBadge,
  MathTrace,
  Money,
  ScreenTitle,
} from '../components.tsx';

const BUDGET_MS = 3000;

export function AffordabilityScreen(): React.ReactNode {
  const { state, snapshot, asOf } = useAppState();
  const accounts = cashAccounts(state.accounts);
  const [amountText, setAmountText] = useState('125.00');
  const [description, setDescription] = useState('Planned purchase');
  const [accountId, setAccountId] = useState(() => state.primaryCashAccountId);
  const parsed = useMemo<{ value: Cents | null; error: string | null }>(() => {
    try {
      return { value: parseMoney(amountText), error: null };
    } catch (cause) {
      return { value: null, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }, [amountText]);
  const started = performance.now();
  const answer = useMemo(
    () =>
      snapshot !== null && parsed.value !== null
        ? checkAffordability(state, snapshot, {
            amount: parsed.value,
            fromAccountId: accountId,
            asOf,
            ...(description.trim() === '' ? {} : { description: description.trim() }),
          })
        : null,
    [accountId, asOf, description, parsed.value, snapshot, state],
  );
  const renderMs = Math.round(performance.now() - started);

  if (snapshot === null)
    return (
      <EmptyState title="No snapshot yet">
        A saved snapshot is needed before checking a purchase.
      </EmptyState>
    );

  return (
    <>
      <ScreenTitle
        title="Affordability Check"
        description="A local until-payday calculation. No API call is made."
        action={<LatencyBadge ms={renderMs} budget={BUDGET_MS} />}
      />
      <Card title="Question">
        <div className="form-grid">
          <label>
            Amount
            <input
              value={amountText}
              onChange={(event) => setAmountText(event.target.value)}
              inputMode="decimal"
            />
          </label>
          <label>
            Description
            <input value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
          <label>
            Pay from
            <select
              value={accountId}
              onChange={(event) => setAccountId(event.target.value as never)}
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {parsed.error === null ? null : (
          <p className="error-text">
            Enter a normal money amount, for example 42.50. {parsed.error}
          </p>
        )}
      </Card>
      {answer === null ? null : (
        <>
          <div className={`verdict ${answer.affordable ? 'yes' : 'no'}`}>
            <strong>
              {answer.affordable ? 'Yes, this fits.' : 'No, this would breach the plan.'}
            </strong>
            <ConfidencePill level={answer.confidence} />
            <p>{answer.reasoning}</p>
          </div>
          <div className="hero-strip">
            <div>
              <span>Remaining balance</span>
              <strong>
                <Money value={answer.projectedBalance} />
              </strong>
            </div>
            <div>
              <span>Buffer impact</span>
              <strong>
                <Money value={answer.cushionShortfall} />
              </strong>
            </div>
            <div>
              <span>Available before purchase</span>
              <strong>
                <Money value={answer.availableToSpend} />
              </strong>
            </div>
            <div>
              <span>Next payday</span>
              <strong>{answer.nextPayday}</strong>
            </div>
          </div>
          <Card title="Commitments counted">
            <table>
              <thead>
                <tr>
                  <th>Commitment</th>
                  <th>Due</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {answer.upcoming.length === 0 ? (
                  <tr>
                    <td colSpan={3}>No recorded commitment due before payday.</td>
                  </tr>
                ) : (
                  answer.upcoming.map((entry) => (
                    <tr key={`${entry.commitment.id}-${entry.dueDate}`}>
                      <td>{entry.commitment.name}</td>
                      <td>{entry.dueDate}</td>
                      <td className="num">
                        <Money value={entry.commitment.amount} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </Card>
          <Card title="Full calculation">
            <MathTrace steps={answer.explanation.steps} />
          </Card>
          <Assumptions items={answer.assumptions} />
        </>
      )}
    </>
  );
}
