import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { FinancialState, Snapshot } from '../domain/accounts.ts';
import { latestSnapshot } from '../domain/accounts.ts';
import { todayIso, type IsoDate } from '../domain/dates.ts';
import type { StrategyId } from '../domain/allocation.ts';
import { DEFAULT_MODEL, liveTransport, type KeyStatus } from '../claude/analysis.ts';
import { NO_KEY } from '../claude/ClaudePort.ts';
import { buildDemoState } from '../seed/demoData.ts';
import { browserPersistence, type UiPersistence } from './persistence.ts';
import { shouldAutoVerifyConnection } from './connectionState.ts';

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
  readonly refreshKeyStatus: () => Promise<void>;
  readonly verifyConnection: () => Promise<void>;
  readonly reloadDemo: () => void;
  readonly clearAllData: () => void;
}

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
  const port = useMemo(() => liveTransport(), []);
  const verificationRef = useRef<Promise<void> | null>(null);
  const autoVerificationAttemptedRef = useRef(false);

  const failedStatus = useCallback((status: KeyStatus, cause: unknown): KeyStatus => {
    if (!status.configured) return NO_KEY;
    return {
      ...status,
      connection: {
        state: 'failed',
        checkedAt: new Date().toISOString(),
        detail: cause instanceof Error ? cause.message : String(cause),
        latencyMs: null,
      },
    };
  }, []);

  const refreshKeyStatus = useCallback(async (): Promise<void> => {
    try {
      setKeyStatus(await port.keyStatus());
    } catch {
      setKeyStatus(NO_KEY);
    }
  }, [port]);

  const verifyConnection = useCallback((): Promise<void> => {
    if (verificationRef.current !== null) return verificationRef.current;
    const task = (async () => {
      try {
        setKeyStatus(await port.verifyConnection());
      } catch (cause) {
        setKeyStatus((current) => failedStatus(current, cause));
      } finally {
        verificationRef.current = null;
      }
    })();
    verificationRef.current = task;
    return task;
  }, [failedStatus, port]);

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
        const status = await port.keyStatus();
        if (!cancelled) setKeyStatus(status);
      } catch {
        if (!cancelled) setKeyStatus(NO_KEY);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [port]);

  useEffect(() => {
    if (autoVerificationAttemptedRef.current) return;
    if (
      !shouldAutoVerifyConnection({
        status: keyStatus,
        verificationInFlight: verificationRef.current !== null,
      })
    )
      return;

    autoVerificationAttemptedRef.current = true;
    void verifyConnection();
  }, [keyStatus, verifyConnection]);

  useEffect(() => {
    if (!loaded) return;
    void persistence.save(state).catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [loaded, persistence, state]);

  const snapshot = useMemo(() => latestSnapshot(state.history) ?? null, [state.history]);

  const value = useMemo<AppContextValue>(
    () => ({
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
      refreshKeyStatus,
      verifyConnection,
      reloadDemo() {
        setFinancialState(buildDemoState(asOf));
        setDemoLoaded(true);
      },
      clearAllData() {
        setFinancialState(emptyState());
        setDemoLoaded(false);
      },
    }),
    [
      asOf,
      demoLoaded,
      error,
      keyStatus,
      loaded,
      refreshKeyStatus,
      selectedModel,
      selectedStrategy,
      snapshot,
      state,
      verifyConnection,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppState(): AppContextValue {
  const context = useContext(AppContext);
  if (context === null) throw new Error('useAppState must be used inside AppProvider');
  return context;
}
