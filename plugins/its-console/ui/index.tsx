// Console root: station picker + mode-aware xterm. Honors `?station=foo` for
// linkability and `?detached=1` for the pop-out window layout (no chrome).

import { useMemo, useState } from 'preact/hooks';
import { subjects, useCachedMap } from '@its/sdk-react';
import { ModeBadge } from './components/ModeBadge';
import { StationPicker } from './components/StationPicker';
import { Terminal } from './components/Terminal';
import './index.css';

type Heartbeat = {
  station: string;
  instance_key: string;
  allow_exec: boolean;
  ts_ms: number;
};

export function ConsoleView() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const detached = params.get('detached') === '1';

  // `station` is the sanitized instance_key (what subjects need); the URL param
  // keeps the legacy name "station". Heartbeat.station is the raw display name.
  const [station, setStation] = useState<string>(params.get('station') ?? '');
  const cmdOverride = params.get('cmd') || undefined;

  // Warm cache means a popped-out console (?station=foo) mounts the terminal
  // without waiting for the next heartbeat.
  const heartbeats = useCachedMap(subjects.itsShell.heartbeat('*'));
  const stationHb = useMemo<Heartbeat | null>(() => {
    if (!station) return null;
    for (const [, entry] of heartbeats) {
      const hb = entry.value as Heartbeat;
      if (hb.instance_key === station) return hb;
    }
    return null;
  }, [heartbeats, station]);

  const mode: 'constrained' | 'full' =
    stationHb?.allow_exec ? 'full' : 'constrained';
  const stationOnline = stationHb && Date.now() - stationHb.ts_ms < 60_000;

  return (
    <div class={`console-view ${detached ? 'console-view-detached' : ''}`}>
      {!detached && (
        <div class="console-header">
          <StationPicker value={station} onChange={setStation} />
          {station && <ModeBadge mode={mode} />}
        </div>
      )}
      {!station && !detached && (
        <div class="console-empty">
          pick a station above to open a session.
        </div>
      )}
      {station && !stationOnline && (
        <div class="console-empty">
          waiting for {station} to heartbeat (start <code>its shell {station === 'localhost' ? 'localhost' : '...'}</code> on that box)...
        </div>
      )}
      {station && stationOnline && (
        <Terminal station={station} mode={mode} cmd={cmdOverride} />
      )}
    </div>
  );
}
