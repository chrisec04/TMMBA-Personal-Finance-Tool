import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_MODEL, liveTransport, type ModelInfo } from '../../claude/analysis.ts';
import { ClaudeError } from '../../claude/ClaudePort.ts';
import { useAppState } from '../AppState.tsx';
import { Card, ScreenTitle } from '../components.tsx';

export function SettingsScreen(): ReactNode {
  const { keyStatus, setKeyStatus, selectedModel, setSelectedModel, reloadDemo, clearAllData, demoLoaded } = useAppState();
  const [key, setKey] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [models, setModels] = useState<readonly ModelInfo[]>([{ id: DEFAULT_MODEL }]);
  const port = useMemo(() => liveTransport(), []);

  useEffect(() => {
    let cancelled = false;
    void port.listModels().then((items) => {
      if (!cancelled) setModels(items.length === 0 ? [{ id: DEFAULT_MODEL }] : items);
    }).catch(() => {
      if (!cancelled) setModels([{ id: DEFAULT_MODEL }]);
    });
    return () => { cancelled = true; };
  }, [keyStatus, port]);

  const saveKey = async (): Promise<void> => {
    setMessage(null);
    try {
      const status = await port.setKey(key);
      setKey('');
      setKeyStatus(status);
      setMessage(`Connected. Saved key ${status.hint === null ? '' : `••••${status.hint}`} from ${status.source}.`);
    } catch (cause) {
      setMessage(cause instanceof ClaudeError || cause instanceof Error ? cause.message : String(cause));
    }
  };

  const clearKey = async (): Promise<void> => {
    try {
      const status = await port.clearKey();
      setKeyStatus(status);
      setMessage('Key cleared. Recorded responses are active.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return <>
    <ScreenTitle title="Settings" description="Keys stay behind the Claude port; the UI never displays them after entry." />
    <Card title="Claude API key"><p className={keyStatus.configured ? 'connected' : 'muted'}>{keyStatus.configured ? `Connected${keyStatus.hint === null ? '' : ` — ••••${keyStatus.hint}`} (${keyStatus.source})` : 'No key — running on recorded responses'}</p><div className="form-grid"><label>API key<input type="password" value={key} onChange={(event) => setKey(event.target.value)} autoComplete="off" /></label><label>Model<select value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)}>{models.map((model) => <option key={model.id} value={model.id}>{model.displayName ?? model.id}</option>)}</select></label></div><div className="inline-row"><button className="btn primary" onClick={() => void saveKey()} disabled={key.trim() === ''}>Save key</button><button className="btn" onClick={() => void clearKey()}>Clear key</button></div>{message === null ? null : <p className="setting-message">{message}</p>}</Card>
    <Card title="Demo data"><p>{demoLoaded ? 'Demo data is currently loaded.' : 'Saved or cleared data is active.'}</p><div className="inline-row"><button className="btn" onClick={reloadDemo}>Reload demo data</button><button className="btn danger" onClick={clearAllData}>Clear all data</button></div></Card>
  </>;
}
