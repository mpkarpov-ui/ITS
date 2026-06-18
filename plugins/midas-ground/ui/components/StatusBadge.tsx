// Header pill showing data status (LIVE / STALE / NO DATA). When stale, ticks a
// packet-age counter at 1Hz; the interval only runs while stale, so live /
// no-data states pay no per-second re-render.

import { useEffect, useState } from 'preact/hooks';
import './StatusBadge.css';

export function StatusBadge({
  lastSeen,
  stale,
}: {
  lastSeen: number | null;
  stale: boolean;
}) {
  // Forces a re-render each second while stale so the displayed age stays current.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!stale || lastSeen === null) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [stale, lastSeen]);

  if (lastSeen === null) {
    return <span class="status-badge status-badge-no-data">NO DATA</span>;
  }
  if (stale) {
    const ageS = Math.max(0, Math.floor((Date.now() - lastSeen) / 1000));
    return (
      <span class="status-badge status-badge-stale">
        STALE
        {/* Hidden at narrow widths (the color already signals the problem). */}
        <span class="status-badge-detail"> (Packet Age {ageS}s)</span>
      </span>
    );
  }
  return <span class="status-badge status-badge-live">LIVE</span>;
}
