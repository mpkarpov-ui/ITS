// Operator-facing intake manager for gss-bridge: running bridges (from the
// server shell's heartbeat) plus a launch form.

import { useState } from 'preact/hooks';
import { commands, subjects, useCommand, useStream } from '@its/sdk-react';
import './BridgesView.css';

const SERVER_SHELL = 'server';

// Channel becomes a NATS subject segment, so restrict to lowercase
// alphanumeric + hyphen.
const CHANNEL_RE = /^[a-z0-9-]+$/;

export function BridgesView() {
  const { value: heartbeat, lastSeen } = useStream(
    subjects.itsShell.heartbeat(SERVER_SHELL),
  );
  const connect = useCommand(commands.itsShell.connect(SERVER_SHELL));
  const disconnect = useCommand(commands.itsShell.disconnect(SERVER_SHELL));

  const allIntakes = heartbeat?.intakes ?? [];
  const bridges = allIntakes.filter((i) => i.plugin === 'gss-bridge');

  const [channel, setChannel] = useState('');
  const [topic, setTopic] = useState('');
  const [url, setUrl] = useState('mqtt://127.0.0.1:1884');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function launch(e: Event) {
    e.preventDefault();
    setError('');
    const ch = channel.trim();
    const tp = topic.trim();
    const u = url.trim();
    if (!ch || !tp || !u) {
      setError('Channel, topic, and URL are all required.');
      return;
    }
    if (!CHANNEL_RE.test(ch)) {
      setError('Channel must be lowercase alphanumeric or hyphen (e.g. m007).');
      return;
    }
    if (bridges.some((b) => b.instance_key === ch)) {
      setError(`A bridge for channel '${ch}' is already running.`);
      return;
    }
    setBusy(true);
    try {
      await connect({
        plugin: 'gss-bridge',
        config: { channel: ch, mqtt_topic: tp, mqtt_url: u },
        autostart: true,
      });
      setChannel('');
      setTopic('');
    } catch (err) {
      setError(`${err}`);
    } finally {
      setBusy(false);
    }
  }

  async function stop(instanceId: string) {
    try {
      await disconnect({ instance_id: instanceId });
    } catch (err) {
      setError(`disconnect failed: ${err}`);
    }
  }

  const shellReady = lastSeen !== null;

  return (
    <div class="bridges-page">
      <header class="bridges-head">
        <span class="bridges-title">GSS BRIDGES</span>
        <span class="bridges-summary">
          {bridges.length} running
        </span>
      </header>

      <div class="bridges-grid">
        <section class="bridges-panel">
          <div class="bridges-panel-label">Running</div>
          {!shellReady && (
            <div class="bridges-empty">Waiting for local shell…</div>
          )}
          {shellReady && bridges.length === 0 && (
            <div class="bridges-empty">No bridges running.</div>
          )}
          {bridges.length > 0 && (
            <ul class="bridges-list">
              {bridges.map((b) => (
                <li key={b.instance_id} class="bridges-row">
                  <span class="bridges-dot" />
                  <span class="bridges-channel">{b.instance_key}</span>
                  <span class="bridges-meta">
                    pid {b.pid}
                  </span>
                  <button
                    class="bridges-btn bridges-btn-stop"
                    onClick={() => stop(b.instance_id)}
                  >
                    Disconnect
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section class="bridges-panel">
          <div class="bridges-panel-label">Launch new</div>
          <form class="bridges-form" onSubmit={launch}>
            <label class="bridges-field">
              <span>Channel</span>
              <input
                type="text"
                value={channel}
                placeholder="m007"
                onInput={(e) => setChannel((e.target as HTMLInputElement).value)}
                disabled={busy}
              />
            </label>
            <label class="bridges-field">
              <span>MQTT topic</span>
              <input
                type="text"
                value={topic}
                placeholder="FlightData-Sustainer"
                onInput={(e) => setTopic((e.target as HTMLInputElement).value)}
                disabled={busy}
              />
            </label>
            <label class="bridges-field">
              <span>MQTT URL</span>
              <input
                type="text"
                value={url}
                onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
                disabled={busy}
              />
            </label>
            {error && <div class="bridges-error">{error}</div>}
            <button
              type="submit"
              class="bridges-btn bridges-btn-primary bridges-btn-launch"
              disabled={busy || !shellReady}
            >
              {busy ? 'Launching…' : 'Launch bridge'}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
