import { useEffect, useState } from 'preact/hooks';
import type { SubjectPayload, SubjectUnion } from '@its/contracts/_subjects';
import { subscribe as wsSubscribe } from './ws-bridge';
import { _cacheMatches, _cacheSet, type CacheEntry } from './cache';

// For a wildcard subject where the consumer wants every currently-known
// concrete subject (e.g. every shell station's last heartbeat). Returns a Map
// keyed on concrete subject, warm-started from the cache and updated per
// message. Map identity changes each update so Preact re-renders; derive
// downstream shapes via useMemo. For a single value, use useCached.
export function useCachedMap<S extends SubjectUnion>(
  subject: S,
): Map<string, { value: SubjectPayload<S>; lastSeen: number }> {
  const [map, setMap] = useState<Map<string, CacheEntry>>(
    () => new Map(_cacheMatches(subject)),
  );

  useEffect(() => {
    // Reset to a fresh cache snapshot on subject change.
    setMap(new Map(_cacheMatches(subject)));
    return wsSubscribe(subject, (v, concreteSubject) => {
      const entry: CacheEntry = { value: v, lastSeen: Date.now() };
      _cacheSet(concreteSubject, v);
      setMap((cur) => {
        const next = new Map(cur);
        next.set(concreteSubject, entry);
        return next;
      });
    });
  }, [subject]);

  return map as Map<string, { value: SubjectPayload<S>; lastSeen: number }>;
}
