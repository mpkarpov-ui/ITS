// Fleet console: station list from heartbeats, per-station detail on select,
// connect wizard for spinning up remote intakes.

import { useEffect, useMemo, useState } from 'preact/hooks';
import { subjects, useCachedMap } from '@its/sdk-react';
import { ConnectWizard } from './components/ConnectWizard';
import { HardwareList } from './components/HardwareList';
import { Intake, IntakeRow } from './components/IntakeRow';
import { Station, StationRow, classifyStation } from './components/StationRow';
import { ValueGroup } from './components/ValueDisplay';
import './index.css';

// Keep mirrored with plugins/its-shell/schemas/heartbeat.py. `station` is the
// raw display name; `instance_key` is the NATS-safe segment for subjects.
type Heartbeat = {
  station: string;
  instance_key: string;
  ts_ms: number;
  uptime_s: number;
  allow_exec: boolean;
  intakes: Intake[];
};

export function FleetView() {
  // Warm-started cache map; the station list paints on tab nav without waiting.
  const stationsMap = useCachedMap(subjects.itsShell.heartbeat('*'));
  const [selected, setSelected] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [, setTick] = useState(0);

  // 1s tick so live/stale/offline recolor promptly; the 3s stale window is too
  // tight for a slower tick.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1_000);
    return () => clearInterval(id);
  }, []);

  // Dedupe by instance_key (the heartbeat subject's wildcard segment).
  const byStation = useMemo<Record<string, Heartbeat>>(() => {
    const out: Record<string, Heartbeat> = {};
    for (const [, entry] of stationsMap) {
      const hb = entry.value as Heartbeat;
      out[hb.instance_key] = hb;
    }
    return out;
  }, [stationsMap]);

  const stations = useMemo<Station[]>(() => {
    return Object.values(byStation).map((hb) => ({
      name: hb.instance_key,       // subject segment
      display_name: hb.station,    // operator-facing raw name
      ts_ms: hb.ts_ms,
      uptime_s: hb.uptime_s,
      allow_exec: hb.allow_exec,
      intake_count: hb.intakes.length,
    })).sort((a, b) => a.name.localeCompare(b.name));
  }, [byStation]);

  const selectedHb = selected ? byStation[selected] : null;

  return (
    <div class="fleet-view">
      <div class="fleet-left">
        <ValueGroup label="Stations">
          {stations.length === 0 ? (
            <div class="fleet-empty">
              no stations reporting. launch one with <code>its shell &lt;host&gt;</code> on a hardware machine.
            </div>
          ) : (
            stations.map((s) => (
              <StationRow
                key={s.name}
                station={s}
                selected={selected === s.name}
                onClick={() => setSelected(s.name)}
              />
            ))
          )}
        </ValueGroup>
      </div>

      <div class="fleet-right">
        {selectedHb ? (
          <>
            <div class="fleet-header">
              <div>
                <div class="fleet-header-name">{selectedHb.station}</div>
                <div class="fleet-header-sub">
                  key={selectedHb.instance_key}
                  {' · '}
                  uptime {formatUptime(selectedHb.uptime_s)}
                  {' · '}
                  status {classifyStation(selectedHb.ts_ms)}
                  {selectedHb.allow_exec && ' · exec enabled'}
                </div>
              </div>
              <div class="fleet-header-actions">
                <button
                  class="fleet-console-btn"
                  title={`Pop out the console for ${selectedHb.station} in a new window`}
                  onClick={() =>
                    window.open(
                      `/console?station=${encodeURIComponent(selectedHb.instance_key)}&detached=1`,
                      `its-console-${selectedHb.instance_key}`,
                      'width=900,height=600,menubar=no',
                    )
                  }
                >
                  Console <span class="fleet-btn-popout">↗</span>
                </button>
                <button class="fleet-connect-btn" onClick={() => setWizardOpen(true)}>
                  + Add intake
                </button>
              </div>
            </div>

            <ValueGroup label="Hardware">
              <HardwareList station={selectedHb.instance_key} />
            </ValueGroup>

            <ValueGroup label="Intakes">
              {selectedHb.intakes.length === 0 ? (
                <div class="fleet-empty">no intakes running on this station.</div>
              ) : (
                selectedHb.intakes.map((it) => (
                  <IntakeRow key={it.instance_id} intake={it} station={selectedHb.instance_key} />
                ))
              )}
            </ValueGroup>
          </>
        ) : (
          <div class="fleet-empty">select a station on the left.</div>
        )}
      </div>

      {wizardOpen && selectedHb && (
        <ConnectWizard
          station={selectedHb.instance_key}
          onClose={() => setWizardOpen(false)}
        />
      )}
    </div>
  );
}

function formatUptime(s: number): string {
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}
