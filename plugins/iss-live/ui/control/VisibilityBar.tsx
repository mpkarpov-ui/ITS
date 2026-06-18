// Quick-toggle row above the tabs. Writes the OverlayVisibility global, seen
// by every operator browser and the OBS browser-source. PANIC clears all
// layers and cuts OBS to the first scene as a safe fallback (no-op if OBS
// isn't connected).

import type { JSX } from 'preact';
import { useOverlayVisibility } from './globals';
import { useObs } from '../services/useObs';
import { obsService } from '../services/obs';
import { ChipButton } from './ui';

export function VisibilityBar() {
  const [vis, setVis] = useOverlayVisibility();
  const obs = useObs();

  const update = (patch: Partial<typeof vis>) => setVis({ ...vis, ...patch });

  const allOff = () =>
    update({ spot: false, top_timer: false, timeline: false, tag: false });

  const panic = () => {
    setVis({ ...vis, spot: false, top_timer: false, timeline: false, tag: false, t_clock: false });
    if (obs.connected && obs.sceneList.length > 0) {
      obsService.setScene(obs.sceneList[0]).catch(() => { /* PANIC is best-effort */ });
    }
  };

  return (
    <div style={rowStyle}>
      <ChipButton active={vis.spot} onClick={() => update({ spot: !vis.spot })}>Telemetry</ChipButton>
      <ChipButton active={vis.top_timer} onClick={() => update({ top_timer: !vis.top_timer })}>Timer</ChipButton>
      <ChipButton active={vis.timeline} onClick={() => update({ timeline: !vis.timeline })}>Timeline</ChipButton>
      <ChipButton active={vis.tag} onClick={() => update({ tag: !vis.tag })}>Name Tag</ChipButton>
      <ChipButton active={vis.t_clock} onClick={() => update({ t_clock: !vis.t_clock })}>T-Clock</ChipButton>

      <div style={sepStyle} />

      <ChipButton
        active={vis.single_stage_mode}
        tone="neutral"
        onClick={() => update({ single_stage_mode: !vis.single_stage_mode })}
      >
        {vis.single_stage_mode ? '1-Stage' : '2-Stage'}
      </ChipButton>

      <div style={sepStyle} />

      <ChipButton active={false} onClick={allOff}>All Off</ChipButton>
      <ChipButton active={true} tone="error" onClick={panic}>Panic</ChipButton>
    </div>
  );
}

const rowStyle: JSX.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.35rem',
  flexWrap: 'wrap',
  marginBottom: '0.7rem',
};
const sepStyle: JSX.CSSProperties = {
  width: '1px',
  height: '1rem',
  background: 'var(--border)',
  margin: '0 0.25rem',
};
