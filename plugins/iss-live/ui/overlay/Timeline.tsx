// Side timeline list. Watches the launch timer to dim past milestones and
// highlight the next-up row; each row's T-time parses to ms-before-T0 and is
// classified past / next / future against midas-ground.timer.

import { useEffect, useState } from 'preact/hooks';
import { globals, useGlobal } from '@its/sdk-react';
import { useOverlayVisibility } from './globals';

export interface TimelineRow {
  t: string;          // display string e.g. "5:30:00" (T-minus)
  desc: string;
}

interface Props {
  programName: string;
  rows: TimelineRow[];
}

// Fallback used when the active format declares no timeline; mirrors the
// legacy Cassie timeline.
export const DEFAULT_TIMELINE: TimelineRow[] = [
  { t: '5:30:00', desc: 'Integration starts' },
  { t: '3:30:00', desc: 'Recovery hands off' },
  { t: '2:30:00', desc: 'Avionics hands off' },
  { t: '1:00:00', desc: 'Team photo' },
  { t: '0:30:00', desc: 'Vehicle on pad' },
  { t: '0:05:00', desc: 'Vehicle power on' },
  { t: '0:00:00', desc: 'Launch' },
];

// Parse "h:mm:ss" or "mm:ss" into positive ms (T-minus).
function parseRowMs(t: string): number {
  const parts = t.split(':').map((p) => parseInt(p, 10) || 0);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, s] = parts;
  return ((h * 60 + m) * 60 + s) * 1000;
}

export function Timeline({ programName, rows }: Props) {
  const vis = useOverlayVisibility();
  const [timer] = useGlobal(globals.midasGround.timer);
  const [, setTick] = useState(0);

  // Re-classify rows once per second while running as we cross each T-time.
  useEffect(() => {
    if (!timer || timer.paused) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [timer?.paused]);

  // ms remaining to T-0 (positive = before launch).
  const tMinusMs = timer
    ? (timer.paused ? timer.paused_value : timer.t0 - Date.now())
    : null;

  // next-up is the last row whose T-minus we've already passed. -1 when no
  // timer or we haven't reached the first row yet.
  const nextIndex = (() => {
    if (tMinusMs === null) return -1;
    for (let i = 0; i < rows.length; i++) {
      if (parseRowMs(rows[i].t) <= tMinusMs) continue;
      return i === 0 ? -1 : i - 1;
    }
    return rows.length - 1;
  })();

  const visible = vis.timeline;
  const fadeClass = visible ? 'generic-fade-in' : 'generic-fade-out';

  return (
    <div className={`iss-timeline start-hidden ${fadeClass}`}>
      <div className="iss-timeline-header">
        <div className="iss-timeline-program">Illinois Space Society</div>
        <div className="iss-timeline-title">"{programName}" Launch Timeline</div>
      </div>
      <div className="iss-timeline-rows">
        {rows.map((r, i) => {
          const past = nextIndex >= 0 && i < nextIndex;
          const next = i === nextIndex;
          return (
            <div
              key={r.t + r.desc}
              className={`iss-timeline-row ${past ? 'iss-timeline-row-past' : ''} ${next ? 'iss-timeline-row-next' : ''}`}
            >
              <span className="iss-timeline-row-t">T-{r.t}</span>
              <span className="iss-timeline-row-desc">{r.desc}</span>
            </div>
          );
        })}
      </div>
      <div className="iss-timeline-footer">All times approximate</div>
    </div>
  );
}
