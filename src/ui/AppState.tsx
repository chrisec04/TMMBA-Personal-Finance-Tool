import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { FinancialState, Snapshot } from '../domain/accounts.ts';
import { latestSnapshot } from '../domain/accounts.ts';
import { todayIso, type IsoDate } from '../domain/dates.ts';
import type { StrategyId } from '../domain/allocation.ts';
import { DEFAULT_MODEL, liveTransport, type KeyStatus } from '../claude/analysis.ts';
import { buildDemoState } from '../seed/demoData.ts';
import { browserPersistence, type UiPersistence } from './persistence.ts';

interface AppContextValue {
  readonly state: FinancialState;
  readonly snapshot: Snapshot | null;
  readonly asOf: IsoDate;
  readonly selectedStrategy: StrategyId;
  readonly selectedModel: string;
  readonly keyStatus: KeyStatus;
  readonly demoLoaded: boolean;
  readonly loaded: boolean;
  readonly error: string | null;
  readonly setState: (state: FinancialState, demoLoaded?: boolean) => void;
  readonly setSelectedStrategy: (strategy: StrategyId) => void;
  readonly setSelectedModel: (model: string) => void;
  readonly setKeyStatus: (status: KeyStatus) => void;
  readonly reloadDemo: () => void;
  readonly clearAllData: () => void;
}

const NO_KEY: KeyStatus = { configured: false, source: 'none', hint: null };
const emptyState = (): FinancialState => ({
  accounts: [],
  commitments: [],
  history: [],
  paydayOfMonth: 15,
  primaryCashAccountId: '' as never,
});

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({
  children,
  persistence = browserPersistence,
}: {
  readonly children: ReactNode;
  readonly persistence?: UiPersistence;
}): ReactNode {
  const [asOf] = useState<IsoDate>(() => todayIso());
  const [state, setFinancialState] = useState<FinancialState>(() => buildDemoState(asOf));
  const [selectedStrategy, setSelectedStrategy] = useState<StrategyId>('avalanche');
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL);
  const [keyStatus, setKeyStatus] = useState<KeyStatus>(NO_KEY);
  const [demoLoaded, setDemoLoaded] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const saved = await persistence.load();
        if (cancelled) return;
        if (saved === null) {
          setFinancialState(buildDemoState(asOf));
          setDemoLoaded(true);
        } else {
          setFinancialState(saved);
          setDemoLoaded(false);
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setFinancialState(buildDemoState(asOf));
          setDemoLoaded(true);
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [asOf, persistence]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await liveTransport().keyStatus();
        if (!cancelled) setKeyStatus(status);
      } catch {
        if (!cancelled) setKeyStatus(NO_KEY);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    void persistence.save(state).catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [loaded, persistence, state]);

  const snapshot = useMemo(() => latestSnapshot(state.history) ?? null, [state.history]);

  const value = useMemo<AppContextValue>(() => ({
    state,
    snapshot,
    asOf,
    selectedStrategy,
    selectedModel,
    keyStatus,
    demoLoaded,
    loaded,
    error,
    setState(next, demo = false) {
      setFinancialState(next);
      setDemoLoaded(demo);
    },
    setSelectedStrategy,
    setSelectedModel,
    setKeyStatus,
    reloadDemo() {
      setFinancialState(buildDemoState(asOf));
      setDemoLoaded(true);
    },
    clearAllData() {
      setFinancialState(emptyState());
      setDemoLoaded(false);
    },
  }), [asOf, demoLoaded, error, keyStatus, loaded, selectedModel, selectedStrategy, snapshot, state]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppState(): AppContextValue {
  const context = useContext(AppContext);
  if (context === null) throw new Error('useAppState must be used inside AppProvider');
  return context;
}

