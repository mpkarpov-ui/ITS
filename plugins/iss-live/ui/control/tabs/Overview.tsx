// Default tab: OBS state, name-tag editor, idle/pre-stream reason text.
// No timer control yet (open question: write midas-ground.timer directly or
// proxy through a midas-ground command).

import type { JSX } from 'preact';
import { useObs } from '../../services/useObs';
import { useIdleText, useNameTag, useOverlayVisibility } from '../globals';
import { Panel, TextInput, FieldLabel, ChipButton } from '../ui';

export function OverviewTab() {
  const obs = useObs();
  const [nameTag, setNameTag] = useNameTag();
  const [idleText, setIdleText] = useIdleText();
  const [vis, setVis] = useOverlayVisibility();

  const activeAudio = Object.entries(obs.inputs)
    .filter(([, info]) => info.muted === false)
    .map(([name]) => name.replace(/_/g, ' '));

  return (
    <div style={columnStyle}>
      <div style={rowStyle}>
        <Panel label="OBS" style={{ flex: 1 }}>
          <KV label="Scene" value={obs.currentScene ?? '—'} />
          <KV label="Stream" value={obs.streaming ? 'LIVE' : 'Off'} tone={obs.streaming ? 'live' : undefined} />
          <KV label="Record" value={obs.recording ? 'REC' : 'Off'} tone={obs.recording ? 'error' : undefined} />
          <KV label="Audio" value={activeAudio.length > 0 ? activeAudio.join(', ') : 'All muted'} />
        </Panel>

        <Panel
          label="Name Tag"
          style={{ flex: 1 }}
          right={
            <ChipButton
              active={vis.tag}
              tone={vis.tag ? 'live' : 'error'}
              onClick={() => setVis({ ...vis, tag: !vis.tag })}
            >
              {vis.tag ? 'Visible' : 'Hidden'}
            </ChipButton>
          }
        >
          <div style={{ marginBottom: '0.55rem' }}>
            <FieldLabel>Title</FieldLabel>
            <TextInput value={nameTag.title} onInput={(v) => setNameTag({ ...nameTag, title: v })} />
          </div>
          <div>
            <FieldLabel>Subtitle</FieldLabel>
            <TextInput value={nameTag.subtitle} onInput={(v) => setNameTag({ ...nameTag, subtitle: v })} />
          </div>
        </Panel>
      </div>

      <Panel label="Idle / Pre-Stream Text">
        <FieldLabel>Reason</FieldLabel>
        <TextInput
          value={idleText.reason_text}
          onInput={(v) => setIdleText({ reason_text: v })}
          placeholder="Standing by for vehicle integration"
        />
        <div style={hintStyle}>Shown on idle, pre-stream, and goodbye overlay screens</div>
      </Panel>
    </div>
  );
}

function KV({ label, value, tone }: { label: string; value: string; tone?: 'live' | 'error' }) {
  const color =
    tone === 'live' ? 'var(--status-live)'
    : tone === 'error' ? 'var(--status-error)'
    : 'var(--text)';
  return (
    <div style={kvRowStyle}>
      <span style={kvLabelStyle}>{label}</span>
      <span style={{ ...kvValueStyle, color }}>{value}</span>
    </div>
  );
}

const columnStyle: JSX.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.6rem',
};
const rowStyle: JSX.CSSProperties = {
  display: 'flex',
  gap: '0.6rem',
};
const hintStyle: JSX.CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: '0.7rem',
  marginTop: '0.4rem',
};
const kvRowStyle: JSX.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  padding: '0.25rem 0',
  borderBottom: '1px solid var(--border-dim)',
  fontSize: '0.8rem',
};
const kvLabelStyle: JSX.CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: '0.65rem',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  width: '4rem',
};
const kvValueStyle: JSX.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontWeight: 500,
  marginLeft: 'auto',
};
