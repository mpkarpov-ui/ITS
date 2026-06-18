// T-clock readout off the midas-ground launch timer global.
//
// digitMode (same numbering as legacy CountdownTimer):
//   1: hh:mm:ss.uuu  (default)
//   2: mm:ss
//   3: mm:ss.uuu     (spot strip)
//   4: hh:mm:ss      (passive timer banner)
//
// Polls at 5ms while running (legacy precision); holds at paused_value when
// paused. `anim` propagates the legacy `overlay-spot-timer-paused` pulse class.

import { useEffect, useState } from 'preact/hooks';
import { globals, useGlobal } from '@its/sdk-react';

export type DigitMode = 1 | 2 | 3 | 4;

interface Props {
  digitMode?: DigitMode;
  anim?: boolean;
}

export function CountdownTimer({ digitMode = 1, anim = true }: Props) {
  const [timer] = useGlobal(globals.midasGround.timer);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!timer || timer.paused) return;
    const id = setInterval(() => setTick((n) => n + 1), 5);
    return () => clearInterval(id);
  }, [timer?.paused]);

  if (!timer) return <span>--:--:--</span>;

  const remaining = timer.paused ? timer.paused_value : timer.t0 - Date.now();
  const sign = remaining < 0 ? '+' : '-';
  const className = timer.paused && anim ? 'overlay-spot-timer-paused' : '';
  return (
    <span className={className}>
      {sign}{formatTime(Math.abs(remaining), digitMode)}
    </span>
  );
}

function formatTime(ms: number, mode: DigitMode): string {
  const hrCount = Math.floor(ms / 3_600_000);
  const hrs = String(hrCount).padStart(2, '0');
  const minsAlt = String(Math.floor((ms % 3_600_000) / 60_000) + 60 * hrCount).padStart(2, '0');
  const mins = String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0');
  const secs = String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0');
  const millis = String(Math.floor(ms % 1000)).padStart(3, '0');
  switch (mode) {
    case 2: return `${minsAlt}:${secs}`;
    case 3: return `${minsAlt}:${secs}.${millis}`;
    case 4: return `${hrs}:${mins}:${secs}`;
    case 1:
    default: return `${hrs}:${mins}:${secs}.${millis}`;
  }
}
