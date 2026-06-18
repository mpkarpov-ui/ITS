import { useEffect, useState } from 'preact/hooks';

// True once `lastSeen` is more than `ms` in the past, false within the window
// or while null. Companion to useStream for a reactive silence indicator.
//
//   const { value, lastSeen } = useStream(subjects.x.y());
//   const stale = useStaleAfter(lastSeen, 3000);
//
// One setTimeout per freshness window, no continuous re-renders: each message
// reschedules, and nothing ticks after the flip. For an age readout render an
// absolute timestamp rather than a live counter.
export function useStaleAfter(lastSeen: number | null, ms: number): boolean {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (lastSeen === null) {
      setStale(false);
      return;
    }
    const wait = lastSeen + ms - Date.now();
    if (wait <= 0) {
      setStale(true);
      return;
    }
    setStale(false);
    const id = setTimeout(() => setStale(true), wait);
    return () => clearTimeout(id);
  }, [lastSeen, ms]);

  return stale;
}
