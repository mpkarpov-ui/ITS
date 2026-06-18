// Dropdown of online stations from cached shell heartbeats.

import { useMemo } from 'preact/hooks';
import { subjects, useCachedMap } from '@its/sdk-react';
import './StationPicker.css';

type Heartbeat = {
  station: string;        // display name (may contain @ etc)
  instance_key: string;   // NATS-safe; use this for subject construction
  ts_ms: number;
  allow_exec: boolean;
};

// `value` is the instance_key; the option label is the raw display name.
export function StationPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (instance_key: string) => void;
}) {
  const stationsMap = useCachedMap(subjects.itsShell.heartbeat('*'));

  const live = useMemo(() => {
    const now = Date.now();
    const out: Heartbeat[] = [];
    for (const [, entry] of stationsMap) {
      const hb = entry.value as Heartbeat;
      if (now - hb.ts_ms < 60_000) out.push(hb);
    }
    return out.sort((a, b) => a.instance_key.localeCompare(b.instance_key));
  }, [stationsMap]);

  return (
    <select
      class="console-station-picker"
      value={value}
      onChange={(e) => onChange((e.target as HTMLSelectElement).value)}
    >
      <option value="">(pick a station)</option>
      {live.map((s) => (
        <option key={s.instance_key} value={s.instance_key}>
          {s.station}{s.allow_exec ? ' [exec]' : ''}
        </option>
      ))}
    </select>
  );
}
