// Presets tab. Cards from the active format's preset list show scene refs,
// overlay-state badges, and scene-validation warnings; click to apply. A
// cycling preset (scenes[] + cycle_interval) rotates scenes via the scene-cycler
// singleton; its card badge shows the live position while rotating.

import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { globals, useGlobal } from '@its/sdk-react';
import { useObs } from '../../services/useObs';
import { useCycler } from '../../services/useCycler';
import { useActiveFormat } from '../../formats/useFormat';
import { applyPreset, validatePreset } from '../../formats/apply';
import type { Preset } from '../../formats/types';
import { Empty, Panel } from '../ui';

export function PresetsTab() {
  const { format, name, error, ready } = useActiveFormat();
  const obs = useObs();
  const cycler = useCycler();
  const [vis] = useGlobal(globals.issLive.overlayVisibility);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [applyErrors, setApplyErrors] = useState<string[]>([]);

  if (!ready) {
    return <Panel label="Presets"><Empty>Loading...</Empty></Panel>;
  }
  if (!name) {
    return (
      <Panel label="Presets">
        <Empty>No active format selected. Pick one in the Formats tab and click "Set Active".</Empty>
      </Panel>
    );
  }
  if (error) {
    return (
      <Panel label="Presets">
        <div style={errorBoxStyle}>{error}</div>
      </Panel>
    );
  }
  if (!format) {
    return <Panel label="Presets"><Empty>Active format is empty.</Empty></Panel>;
  }

  const presets: Preset[] = format.presets ?? [];

  const handleClick = async (preset: Preset) => {
    setActiveId(preset.id);
    const result = await applyPreset(preset, format, vis);
    setApplyErrors(result.errors);
  };

  return (
    <div style={columnStyle}>
      <Panel
        label={`Presets · ${name}`}
        right={
          <span style={countStyle}>{presets.length} preset{presets.length === 1 ? '' : 's'}</span>
        }
      >
        {presets.length === 0 ? (
          <Empty>This format defines no presets. Add some in the Formats tab.</Empty>
        ) : (
          <div style={gridStyle}>
            {presets.map((p) => (
              <PresetCard
                key={p.id}
                preset={p}
                isActive={activeId === p.id}
                warnings={validatePreset(p, format, obs.sceneList)}
                obsConnected={obs.connected}
                currentScene={obs.currentScene}
                cyclePos={cycler.presetId === p.id ? cycler.index : null}
                nextSwitchAt={cycler.presetId === p.id ? cycler.nextSwitchAt : null}
                onClick={() => handleClick(p)}
              />
            ))}
          </div>
        )}
      </Panel>

      {applyErrors.length > 0 && (
        <Panel label="Last apply">
          <div style={errorListStyle}>
            {applyErrors.map((e, i) => <div key={i} style={errorRowStyle}>{e}</div>)}
          </div>
        </Panel>
      )}
    </div>
  );
}

function PresetCard({
  preset,
  isActive,
  warnings,
  obsConnected,
  currentScene,
  cyclePos,
  nextSwitchAt,
  onClick,
}: {
  preset: Preset;
  isActive: boolean;
  warnings: string[];
  obsConnected: boolean;
  currentScene: string | null;
  cyclePos: number | null;       // current scene index while this preset cycles, else null
  nextSwitchAt: number | null;   // epoch ms of the next switch while cycling, else null
  onClick: () => void;
}) {
  const allScenes = preset.scenes ?? (preset.scene ? [preset.scene] : []);
  const hasCycle = (preset.scenes?.length ?? 0) > 1 && !!preset.cycle_interval;
  const overlayBadges: Array<[string, boolean]> = [
    ['Spot', !!preset.overlay_state?.spot],
    ['Timer', !!preset.overlay_state?.top_timer],
    ['Timeline', !!preset.overlay_state?.timeline],
    ['Tag', !!preset.overlay_state?.tag || !!preset.target_desc],
  ];

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...cardStyle,
        ...(isActive ? cardActiveStyle : {}),
        ...(warnings.length > 0 ? cardWarnStyle : {}),
      }}
    >
      <div style={headerStyle}>
        <span style={nameStyle}>{preset.name}</span>
        {hasCycle && (
          <CycleBadge
            intervalS={preset.cycle_interval!}
            pos={cyclePos}
            total={allScenes.length}
            nextSwitchAt={nextSwitchAt}
          />
        )}
      </div>
      {preset.description && <div style={descStyle}>{preset.description}</div>}

      <div style={sceneListStyle}>
        {allScenes.map((s) => {
          const isCurrent = obsConnected && currentScene === s;
          return (
            <span
              key={s}
              style={{
                ...sceneTagStyle,
                ...(isCurrent ? sceneTagCurrentStyle : {}),
              }}
            >
              {s}
            </span>
          );
        })}
      </div>

      <div style={overlayRowStyle}>
        {overlayBadges.map(([label, on]) => (
          <span
            key={label}
            style={{
              ...overlayBadgeStyle,
              ...(on ? overlayBadgeOnStyle : {}),
            }}
          >
            {label}
          </span>
        ))}
        {preset.audio_preset && (
          <span style={audioBadgeStyle}>Audio: {preset.audio_preset}</span>
        )}
      </div>

      {warnings.length > 0 && (
        <div style={warningsStyle}>
          {warnings.map((w, i) => <div key={i} style={warningRowStyle}>{w}</div>)}
        </div>
      )}
    </button>
  );
}

// Cycle badge: static "Cycle Ns" when idle; while this preset rotates it shows
// position plus a live countdown to the next switch, self-ticking off the
// cycler's nextSwitchAt so it stays accurate across switches.
function CycleBadge({
  intervalS,
  pos,
  total,
  nextSwitchAt,
}: {
  intervalS: number;
  pos: number | null;
  total: number;
  nextSwitchAt: number | null;
}) {
  const cycling = pos !== null && nextSwitchAt !== null;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!cycling) return;
    const id = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [cycling, nextSwitchAt]);

  if (!cycling) {
    return <span style={cycleBadgeStyle}>Cycle {intervalS}s</span>;
  }
  const remaining = Math.max(0, Math.ceil((nextSwitchAt! - Date.now()) / 1000));
  return (
    <span style={{ ...cycleBadgeStyle, ...cycleBadgeActiveStyle }}>
      Cycling {pos! + 1}/{total} · {remaining}s
    </span>
  );
}

const columnStyle: JSX.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.6rem',
};
const gridStyle: JSX.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(15rem, 1fr))',
  gap: '0.6rem',
};
const cardStyle: JSX.CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: '5px',
  padding: '0.7rem 0.8rem',
  textAlign: 'left',
  fontFamily: 'var(--sans)',
  cursor: 'pointer',
  transition: 'border-color 120ms, background 120ms',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.45rem',
};
const cardActiveStyle: JSX.CSSProperties = {
  borderColor: 'var(--accent)',
  background: 'rgba(90, 163, 255, 0.08)',
};
const cardWarnStyle: JSX.CSSProperties = {
  borderColor: 'var(--status-stale)',
};
const headerStyle: JSX.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.4rem',
};
const nameStyle: JSX.CSSProperties = {
  color: 'var(--text)',
  fontWeight: 600,
  fontSize: '0.92rem',
  letterSpacing: '0.02em',
};
const cycleBadgeStyle: JSX.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: '0.6rem',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
  border: '1px solid var(--accent-dim)',
  borderRadius: '3px',
  padding: '0.1rem 0.4rem',
};
const cycleBadgeActiveStyle: JSX.CSSProperties = {
  color: 'var(--status-live)',
  borderColor: 'var(--status-live)',
  background: 'color-mix(in srgb, var(--status-live) 14%, transparent)',
};
const descStyle: JSX.CSSProperties = {
  color: 'var(--text-dim)',
  fontSize: '0.75rem',
  lineHeight: 1.4,
};
const sceneListStyle: JSX.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.3rem',
};
const sceneTagStyle: JSX.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: '0.65rem',
  letterSpacing: '0.05em',
  color: 'var(--text-dim)',
  border: '1px solid var(--border)',
  borderRadius: '3px',
  padding: '0.15rem 0.5rem',
};
const sceneTagCurrentStyle: JSX.CSSProperties = {
  color: 'var(--accent)',
  borderColor: 'var(--accent)',
  background: 'rgba(90, 163, 255, 0.1)',
};
const overlayRowStyle: JSX.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.25rem',
};
const overlayBadgeStyle: JSX.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: '0.6rem',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
  border: '1px solid var(--border-dim)',
  borderRadius: '3px',
  padding: '0.1rem 0.4rem',
};
const overlayBadgeOnStyle: JSX.CSSProperties = {
  color: 'var(--status-live)',
  borderColor: 'var(--status-live)',
};
const audioBadgeStyle: JSX.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: '0.6rem',
  letterSpacing: '0.05em',
  color: 'var(--text-dim)',
  border: '1px solid var(--border)',
  borderRadius: '3px',
  padding: '0.1rem 0.4rem',
  marginLeft: 'auto',
};
const warningsStyle: JSX.CSSProperties = {
  paddingTop: '0.4rem',
  borderTop: '1px solid var(--border-dim)',
};
const warningRowStyle: JSX.CSSProperties = {
  color: 'var(--status-stale)',
  fontSize: '0.7rem',
  fontFamily: 'var(--mono)',
};
const countStyle: JSX.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: '0.65rem',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};
const errorBoxStyle: JSX.CSSProperties = {
  background: 'rgba(255, 90, 90, 0.08)',
  border: '1px solid var(--status-error)',
  borderRadius: '4px',
  padding: '0.6rem 0.8rem',
  color: 'var(--status-error)',
  fontFamily: 'var(--mono)',
  fontSize: '0.78rem',
};
const errorListStyle: JSX.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.3rem',
};
const errorRowStyle: JSX.CSSProperties = {
  color: 'var(--status-error)',
  fontFamily: 'var(--mono)',
  fontSize: '0.75rem',
};
