import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_MODEL, liveTransport, type ModelInfo } from '../../claude/analysis.ts';
import {
  ClaudeError,
  describeConnection,
  type ConnectionSummary,
  type KeyStatus,
} from '../../claude/ClaudePort.ts';
import { useAppState } from '../AppState.tsx';
import { Card, ScreenTitle } from '../components.tsx';
import '../connection.css';

const ICONS: Record<ConnectionSummary['tone'], string> = {
  ok: '✓',
  warn: '!',
  bad: '✕',
  idle: '◇',
};

function checkedAt(status: KeyStatus): string | null {
  const value = status.connection.checkedAt;
  if (value === null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function failureHelp(detail: string): string {
  return /reach|network|upstream|timeout|service|quota|proxy/i.test(detail)
    ? 'Action: check your network, the local proxy, Anthropic service status, or quota, then test again.'
    : 'Action: check that the saved key is current, correctly pasted, and allowed to call Anthropic.';
}

export function SettingsScreen(): ReactNode {
  const {
    keyStatus,
    setKeyStatus,
    verifyConnection,
    selectedModel,
    setSelectedModel,
    reloadDemo,
    clearAllData,
    demoLoaded,
  } = useAppState();
  const [key, setKey] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [models, setModels] = useState<readonly ModelInfo[]>([{ id: DEFAULT_MODEL }]);
  const [testing, setTesting] = useState(false);
  const port = useMemo(() => liveTransport(), []);
  const connection = describeConnection(keyStatus);
  const lastChecked = checkedAt(keyStatus);

  const loadModels = useCallback(async (): Promise<void> => {
    try {
      const items = await port.listModels();
      setModels(items.length === 0 ? [{ id: DEFAULT_MODEL }] : items);
    } catch {
      setModels([{ id: DEFAULT_MODEL }]);
    }
  }, [port]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const items = await port.listModels();
        if (!cancelled) setModels(items.length === 0 ? [{ id: DEFAULT_MODEL }] : items);
      } catch {
        if (!cancelled) setModels([{ id: DEFAULT_MODEL }]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [keyStatus, port]);

  const saveKey = async (): Promise<void> => {
    setMessage(null);
    try {
      const status = await port.setKey(key);
      setKey('');
      setKeyStatus(status);
      setMessage(
        `Connected. Saved key ${status.hint === null ? '' : `••••${status.hint}`} from ${status.source}.`,
      );
      await loadModels();
    } catch (cause) {
      setMessage(
        cause instanceof ClaudeError || cause instanceof Error ? cause.message : String(cause),
      );
    }
  };

  const testConnection = async (): Promise<void> => {
    setMessage(null);
    setTesting(true);
    await verifyConnection();
    setTesting(false);
    await loadModels();
  };

  const clearKey = async (): Promise<void> => {
    try {
      const status = await port.clearKey();
      setKeyStatus(status);
      setMessage('Key cleared. Recorded responses are active.');
      setModels([{ id: DEFAULT_MODEL }]);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <>
      <ScreenTitle
        title="Settings"
        description="Keys stay behind the Claude port; the UI never displays them after entry."
      />
      <Card title="Claude API key">
        <div
          className={`connection-card connection-${connection.tone}`}
          role="status"
          aria-live="polite"
        >
          <span className="connection-icon" aria-hidden="true">
            {ICONS[connection.tone]}
          </span>
          <div>
            <p className="connection-label">{connection.label}</p>
            <p>{connection.detail}</p>
            <dl className="connection-meta">
              <div>
                <dt>Stored key</dt>
                <dd>{keyStatus.hint === null ? 'None' : `••••${keyStatus.hint}`}</dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>{keyStatus.source}</dd>
              </div>
              <div>
                <dt>Last checked</dt>
                <dd>{lastChecked ?? 'Never'}</dd>
              </div>
            </dl>
            {keyStatus.connection.state === 'failed' && keyStatus.connection.detail !== null ? (
              <p className="connection-failure">
                <strong>Failure detail:</strong> {keyStatus.connection.detail}
                <br />
                {failureHelp(keyStatus.connection.detail)}
              </p>
            ) : null}
          </div>
        </div>
        <div className="form-grid">
          <label>
            API key
            <input
              type="password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            Model
            <select
              value={selectedModel}
              onChange={(event) => setSelectedModel(event.target.value)}
            >
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName ?? model.id}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="inline-row">
          <button
            className="btn primary"
            onClick={() => void saveKey()}
            disabled={key.trim() === ''}
          >
            Save key
          </button>
          <button className="btn" onClick={() => void testConnection()} disabled={testing}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <button className="btn" onClick={() => void clearKey()}>
            Clear key
          </button>
        </div>
        {message === null ? null : <p className="setting-message">{message}</p>}
      </Card>
      <Card title="Demo data">
        <p>{demoLoaded ? 'Demo data is currently loaded.' : 'Saved or cleared data is active.'}</p>
        <div className="inline-row">
          <button className="btn" onClick={reloadDemo}>
            Reload demo data
          </button>
          <button className="btn danger" onClick={clearAllData}>
            Clear all data
          </button>
        </div>
      </Card>
    </>
  );
}
