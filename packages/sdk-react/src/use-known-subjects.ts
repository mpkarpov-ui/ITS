import { useEffect, useState } from 'preact/hooks';
import { knownSubjects, subscribeKnownSubjects } from './ws-bridge';

// Live list of subjects in the telemetry cache, optionally filtered to a NATS
// pattern. Seeded synchronously from the persisted cache on mount (so a reload
// reflects everything transmitted within the retention window) and updated as
// subjects appear or the cache clears. Makes "discovered targets" a derived
// view of the cache rather than a second store that needs syncing.
export function useKnownSubjects(pattern?: string): string[] {
  const [subjects, setSubjects] = useState<string[]>(() => knownSubjects(pattern));
  useEffect(() => {
    // Recompute in case the pattern or cache changed before the effect ran.
    setSubjects(knownSubjects(pattern));
    return subscribeKnownSubjects(() => setSubjects(knownSubjects(pattern)));
  }, [pattern]);
  return subjects;
}
