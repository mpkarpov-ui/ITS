// Operator's broadcast control deck: visibility bar on top, tab area + OBS
// sidebar below. Active tab persists via usePersisted across refreshes.

import type { JSX } from 'preact';
import { usePersisted } from '@its/sdk-react';
import { Sidebar } from './Sidebar';
import { VisibilityBar } from './VisibilityBar';
import { OverviewTab } from './tabs/Overview';
import { PresetsTab } from './tabs/Presets';
import { ScenesTab } from './tabs/Scenes';
import { AudioTab } from './tabs/Audio';
import { FormatsTab } from './tabs/Formats';

const TABS = [
  { id: 'overview', label: 'Overview', component: OverviewTab },
  { id: 'presets', label: 'Presets', component: PresetsTab },
  { id: 'scenes', label: 'Scenes', component: ScenesTab },
  { id: 'audio', label: 'Audio', component: AudioTab },
  { id: 'formats', label: 'Formats', component: FormatsTab },
] as const;

type TabId = typeof TABS[number]['id'];

export function ControlDeck() {
  const [activeTab, setActiveTab] = usePersisted<TabId>('iss-live', 'active_tab', 'overview');
  const ActiveTabComponent = (TABS.find((t) => t.id === activeTab) ?? TABS[0]).component;

  return (
    <main style={pageStyle}>
      <header style={headerStyle}>
        <span style={brandStyle}>ISS-LIVE</span>
        <span style={mottoStyle}>broadcast control</span>
      </header>

      <VisibilityBar />

      <div style={bodyStyle}>
        <div style={mainColStyle}>
          <div style={tabBarStyle}>
            {TABS.map((t) => {
              const isActive = activeTab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setActiveTab(t.id)}
                  style={{
                    ...tabStyle,
                    ...(isActive ? tabActiveStyle : {}),
                  }}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
          <div style={tabBodyStyle}>
            <ActiveTabComponent />
          </div>
        </div>

        <Sidebar />
      </div>
    </main>
  );
}

const pageStyle: JSX.CSSProperties = {
  padding: '1rem 1.3rem 2rem',
  width: '100%',
  boxSizing: 'border-box',
};
const headerStyle: JSX.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: '0.8rem',
  marginBottom: '1rem',
  paddingBottom: '0.7rem',
  borderBottom: '1px solid var(--border)',
};
const brandStyle: JSX.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: '1.2rem',
  fontWeight: 700,
  letterSpacing: '0.2em',
  color: 'var(--text)',
};
const mottoStyle: JSX.CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: '0.68rem',
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
};
const bodyStyle: JSX.CSSProperties = {
  display: 'flex',
  gap: '0.8rem',
  alignItems: 'flex-start',
};
const mainColStyle: JSX.CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
};
const tabBarStyle: JSX.CSSProperties = {
  display: 'flex',
  gap: '0.15rem',
  borderBottom: '1px solid var(--border)',
  marginBottom: '0.7rem',
};
const tabStyle: JSX.CSSProperties = {
  padding: '0.5rem 1rem',
  fontFamily: 'var(--mono)',
  fontSize: '0.72rem',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  background: 'transparent',
  border: 'none',
  borderBottom: '2px solid transparent',
  marginBottom: '-1px',
  color: 'var(--text-muted)',
  cursor: 'pointer',
  transition: 'color 120ms, border-color 120ms',
};
const tabActiveStyle: JSX.CSSProperties = {
  color: 'var(--accent)',
  borderBottomColor: 'var(--accent)',
};
const tabBodyStyle: JSX.CSSProperties = {
  minHeight: '14rem',
};
