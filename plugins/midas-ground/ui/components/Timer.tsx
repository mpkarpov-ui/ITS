// Flight-count timer. Ported from GSS's FlightCountTimer + Timer. Reads the
// shared `timer` global, ticks via rAF while running, freezes at paused_value
// when paused.

import { useEffect, useState } from 'preact/hooks';
import { globals, useGlobal } from '@its/sdk-react';
import './Timer.css';

const pad = (n: number, width: number) => String(n).padStart(width, '0');

function formatTime(ms: number): string {
  const abs = Math.abs(ms);
  const hours = Math.floor(abs / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);
  const seconds = Math.floor((abs % 60_000) / 1000);
  const millis = Math.floor(abs % 1000);
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(millis, 3)}`;
}

export function FlightCountTimer() {
  const [state, , { ready }] = useGlobal(globals.midasGround.timer);
  const [now, setNow] = useState(() => Date.now());

  // rAF only while running; effect re-runs on paused flip to stop/start cleanly.
  useEffect(() => {
    if (!state || state.paused) return;
    let frame = 0;
    const tick = () => {
      setNow(Date.now());
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [state?.paused]);

  if (!ready) {
    return (
      <div class="value-card cmd-timer-card">
        <div class="value-card-name">Flight Count</div>
        <div class="cmd-timer-display cmd-timer-idle">loading…</div>
      </div>
    );
  }
  if (state === null) {
    return (
      <div class="value-card cmd-timer-card">
        <div class="card-overlay">NO TIMER</div>
        <div class="value-card-name">Flight Count</div>
        <div class="cmd-timer-display card-hide">
          <span class="cmd-timer-t-text">T- </span>
          00:00:00.000
        </div>
      </div>
    );
  }

  // display_ms > 0 = before t0 (T-); <= 0 = at/after t0 (T+).
  const display_ms = state.paused ? state.paused_value : state.t0 - now;
  const tPrefix = display_ms > 0 ? 'T-' : 'T+';

  return (
    <div class="value-card cmd-timer-card">
      <div class="value-card-name">Flight Count</div>
      <div
        class={`cmd-timer-display ${state.paused ? 'cmd-timer-paused' : ''}`}
      >
        <span class="cmd-timer-t-text">{tPrefix} </span>
        {formatTime(display_ms)}
      </div>
    </div>
  );
}
