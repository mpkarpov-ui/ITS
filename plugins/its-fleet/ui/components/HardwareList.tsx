// Per-station hardware catalog. v1 covers serial ports only.

import { subjects, useCached } from '@its/sdk-react';
import './HardwareList.css';

export function HardwareList({ station }: { station: string }) {
  // Cached so the detail shows last-known hardware instead of waiting up to 10s.
  const { value: hw } = useCached(subjects.itsShell.hardware(station));
  if (!hw) return <div class="hw-list-empty">waiting for hardware catalog...</div>;

  return (
    <div class="hw-list">
      <div class="hw-section">
        <div class="hw-section-label">Serial ports</div>
        {hw.ports.length === 0 ? (
          <div class="hw-empty">(none)</div>
        ) : (
          hw.ports.map((p) => (
            <div key={p.device} class="hw-port">
              <span class="hw-port-name">{p.device}</span>
              <span class="hw-port-desc">{p.description}</span>
              {p.manufacturer && <span class="hw-port-mfr">{p.manufacturer}</span>}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
