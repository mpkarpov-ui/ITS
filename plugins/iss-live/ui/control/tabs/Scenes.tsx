// Raw OBS scene grid; click a card to switch the program scene. Unfiltered
// list straight from OBS, no preset validation.

import type { JSX } from 'preact';
import { useObs } from '../../services/useObs';
import { obsService } from '../../services/obs';
import { Empty, Panel } from '../ui';

export function ScenesTab() {
  const obs = useObs();

  if (!obs.connected) {
    return (
      <Panel label="Scenes">
        <Empty>OBS not connected</Empty>
      </Panel>
    );
  }

  return (
    <Panel label={`Scenes (${obs.sceneList.length})`}>
      <div style={currentStyle}>
        Current: <span style={currentValueStyle}>{obs.currentScene ?? 'Unknown'}</span>
      </div>
      <div style={gridStyle}>
        {obs.sceneList.map((sceneName) => {
          const isCurrent = obs.currentScene === sceneName;
          return (
            <button
              key={sceneName}
              type="button"
              onClick={() => obsService.setScene(sceneName).catch((e) => console.warn('[scenes]', e))}
              style={{
                ...sceneCardStyle,
                ...(isCurrent ? sceneCardActiveStyle : {}),
              }}
            >
              {sceneName}
            </button>
          );
        })}
      </div>
    </Panel>
  );
}

const currentStyle: JSX.CSSProperties = {
  marginBottom: '0.55rem',
  fontSize: '0.78rem',
  color: 'var(--text-dim)',
};
const currentValueStyle: JSX.CSSProperties = {
  fontFamily: 'var(--mono)',
  color: 'var(--text)',
  fontWeight: 500,
  marginLeft: '0.25rem',
};
const gridStyle: JSX.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(12rem, 1fr))',
  gap: '0.4rem',
};
const sceneCardStyle: JSX.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: '4px',
  padding: '0.55rem 0.8rem',
  color: 'var(--text-dim)',
  fontFamily: 'var(--mono)',
  fontSize: '0.78rem',
  cursor: 'pointer',
  textAlign: 'center',
  transition: 'border-color 120ms, color 120ms',
};
const sceneCardActiveStyle: JSX.CSSProperties = {
  borderColor: 'var(--accent)',
  color: 'var(--accent)',
};
