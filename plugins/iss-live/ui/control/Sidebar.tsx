// OBS connection panel. Last-used server IP lives in usePersisted (scratch
// state, not a Settings preference: it's the broadcast machine's IP).
// Auto-connects on mount if an IP is saved; obs-websocket-js handles
// re-attaches after that.

import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { usePersisted } from '@its/sdk-react';
import { obsService } from '../services/obs';
import { useObs } from '../services/useObs';
import { Panel, StatusDot, TextInput, FieldLabel } from './ui';

const DEFAULT_PORT = 4455;
const DEFAULT_PASSWORD = 'issuiuc';

export function Sidebar() {
  const obs = useObs();
  const [serverIp, setServerIp] = usePersisted<string>('iss-live', 'obs_server_ip', '192.168.0.200');
  const [autoConnectAttempted, setAutoConnectAttempted] = useState(false);

  useEffect(() => {
    if (autoConnectAttempted) return;
    setAutoConnectAttempted(true);
    if (serverIp) {
      obsService.connect(`ws://${serverIp}:${DEFAULT_PORT}`, DEFAULT_PASSWORD);
    }
  }, []);

  const statusColor =
    obs.connected ? 'var(--status-live)'
    : obs.connecting ? 'var(--status-stale)'
    : 'var(--status-error)';

  const handleToggle = () => {
    if (obs.connected) {
      obsService.disconnect();
    } else {
      obsService.connect(`ws://${serverIp}:${DEFAULT_PORT}`, DEFAULT_PASSWORD);
    }
  };

  return (
    <aside style={sidebarStyle}>
      <Panel label="OBS Connection">
        <div style={statusRowStyle}>
          <StatusDot color={statusColor} />
          <span style={statusLabelStyle}>
            {obs.connected ? 'Connected' : obs.connecting ? 'Connecting' : 'Disconnected'}
          </span>
        </div>

        <div style={{ marginTop: '0.7rem' }}>
          <FieldLabel>Server IP</FieldLabel>
          <TextInput value={serverIp} onInput={setServerIp} placeholder="192.168.0.200" />
        </div>

        <button
          type="button"
          onClick={handleToggle}
          style={{
            ...connectButtonStyle,
            borderColor: obs.connected ? 'var(--status-error)' : 'var(--accent)',
            color: obs.connected ? 'var(--status-error)' : 'var(--accent)',
          }}
        >
          {obs.connected ? 'Disconnect' : obs.connecting ? 'Connecting...' : 'Connect'}
        </button>

        <div style={statusMessageStyle}>{obs.statusMessage}</div>
      </Panel>

      {obs.connected && (
        <Panel label="OBS Status">
          <KV label="Scene" value={obs.currentScene ?? '—'} />
          <KV label="Stream" value={obs.streaming ? 'LIVE' : 'Off'} tone={obs.streaming ? 'live' : undefined} />
          <KV label="Record" value={obs.recording ? 'REC' : 'Off'} tone={obs.recording ? 'error' : undefined} />
        </Panel>
      )}

      {!obs.connected && !obs.connecting && (
        <Panel label="Troubleshooting">
          <ol style={troubleshootStyle}>
            <li>Open OBS Studio</li>
            <li>Tools → WebSocket Server Settings</li>
            <li>Enable on port {DEFAULT_PORT}</li>
            <li>Password: <code style={codeStyle}>{DEFAULT_PASSWORD}</code></li>
          </ol>
        </Panel>
      )}
    </aside>
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

const sidebarStyle: JSX.CSSProperties = {
  width: '17rem',
  flexShrink: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
};
const statusRowStyle: JSX.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
};
const statusLabelStyle: JSX.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: '0.82rem',
  color: 'var(--text)',
};
const connectButtonStyle: JSX.CSSProperties = {
  marginTop: '0.7rem',
  width: '100%',
  background: 'transparent',
  border: '1px solid var(--accent)',
  borderRadius: '3px',
  color: 'var(--accent)',
  padding: '0.5rem 0.7rem',
  fontFamily: 'var(--mono)',
  fontSize: '0.75rem',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  cursor: 'pointer',
  transition: 'border-color 120ms, color 120ms',
};
const statusMessageStyle: JSX.CSSProperties = {
  marginTop: '0.55rem',
  color: 'var(--text-muted)',
  fontSize: '0.72rem',
  fontFamily: 'var(--mono)',
};
const kvRowStyle: JSX.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  padding: '0.25rem 0',
  borderBottom: '1px solid var(--border-dim)',
  fontSize: '0.78rem',
};
const kvLabelStyle: JSX.CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: '0.65rem',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  width: '4.5rem',
};
const kvValueStyle: JSX.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontWeight: 500,
  marginLeft: 'auto',
};
const troubleshootStyle: JSX.CSSProperties = {
  color: 'var(--text-dim)',
  fontSize: '0.75rem',
  paddingLeft: '1.1rem',
  margin: 0,
  lineHeight: 1.6,
};
const codeStyle: JSX.CSSProperties = {
  fontFamily: 'var(--mono)',
  background: 'var(--bg)',
  padding: '0.05rem 0.3rem',
  borderRadius: '2px',
  color: 'var(--text)',
};
