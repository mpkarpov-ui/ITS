// One row in the Fleet station list: status color, name, exec flag, intake count.

import './StationRow.css';

type Status = 'online' | 'stale' | 'offline';

export type Station = {
  name: string;             // sanitized instance_key (what appears on the bus)
  display_name: string;     // raw name from the heartbeat (may contain @ etc.)
  ts_ms: number;
  uptime_s: number;
  allow_exec: boolean;
  intake_count: number;
};

// Keep in sync with Home.tsx and its-shell-watchdog. Shells beat at 1Hz:
// 3s = stale, 10s = offline.
const SHELL_STALE_MS = 3_000;
const SHELL_OFFLINE_MS = 10_000;

export function classifyStation(ts_ms: number, now_ms: number = Date.now()): Status {
  const age_ms = now_ms - ts_ms;
  if (age_ms < SHELL_STALE_MS) return 'online';
  if (age_ms < SHELL_OFFLINE_MS) return 'stale';
  return 'offline';
}

export function StationRow({
  station,
  selected,
  onClick,
}: {
  station: Station;
  selected: boolean;
  onClick: () => void;
}) {
  const status = classifyStation(station.ts_ms);
  return (
    <div
      class={`station-row station-row-${status} ${selected ? 'station-row-selected' : ''}`}
      onClick={onClick}
    >
      <span class={`station-dot station-dot-${status}`} />
      <span class="station-name">{station.display_name}</span>
      <span class="station-meta">
        {station.intake_count} intake{station.intake_count === 1 ? '' : 's'}
        {station.allow_exec && <span class="station-badge">exec</span>}
      </span>
      <span class="station-uptime">{formatUptime(station.uptime_s)}</span>
    </div>
  );
}

function formatUptime(s: number): string {
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}
