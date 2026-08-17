import { Component, useState, type ErrorInfo, type ReactNode } from 'react';
import { AppProvider, useAppState } from './AppState.tsx';
import { SnapshotScreen } from './screens/Snapshot.tsx';
import { AffordabilityScreen } from './screens/Affordability.tsx';
import { RecommendationScreen } from './screens/Recommendation.tsx';
import { ValidationScreen } from './screens/Validation.tsx';
import { TrendsScreen } from './screens/Trends.tsx';
import { SettingsScreen } from './screens/Settings.tsx';

type Route = 'snapshot' | 'affordability' | 'recommendation' | 'validation' | 'trends' | 'settings';

const NAV: readonly { readonly route: Route; readonly label: string }[] = [
  { route: 'snapshot', label: 'Snapshot' },
  { route: 'affordability', label: 'Affordability' },
  { route: 'recommendation', label: 'Debt allocation' },
  { route: 'validation', label: 'Validation' },
  { route: 'trends', label: 'Trends' },
  { route: 'settings', label: 'Settings' },
];

class ErrorBoundary extends Component<{ readonly children: ReactNode }, { readonly error: string | null }> {
  constructor(props: { readonly children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: unknown): { readonly error: string } {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo): void {}

  override render(): ReactNode {
    if (this.state.error !== null) {
      return <main className="fault"><h1>Something went wrong</h1><p>{this.state.error}</p><p>The app kept the fault visible instead of showing a blank screen.</p></main>;
    }
    return this.props.children;
  }
}

function Shell(): ReactNode {
  const { demoLoaded, loaded, error } = useAppState();
  const [route, setRoute] = useState<Route>('snapshot');

  const screen = route === 'snapshot' ? <SnapshotScreen />
    : route === 'affordability' ? <AffordabilityScreen />
      : route === 'recommendation' ? <RecommendationScreen />
        : route === 'validation' ? <ValidationScreen />
          : route === 'trends' ? <TrendsScreen />
            : <SettingsScreen />;

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><div className="brand-mark">PFT</div><div><strong>Personal Finance Tool</strong><span>Explainable planning</span></div></div><nav>{NAV.map((item) => <button key={item.route} className={route === item.route ? 'active' : ''} onClick={() => setRoute(item.route)}>{item.label}</button>)}</nav><p className="sidebar-note">Every figure either comes from the domain layer or shows its math.</p></aside>
    <div className="workspace">{demoLoaded ? <div className="demo-banner"><strong>Demo data</strong> These figures are fictional and safe for screenshots.</div> : null}{error === null ? null : <div className="warning-panel">{error}</div>}{loaded ? screen : <main className="empty"><h2>Loading…</h2></main>}</div>
  </div>;
}

export function App(): ReactNode {
  return <ErrorBoundary><AppProvider><Shell /></AppProvider></ErrorBoundary>;
}
