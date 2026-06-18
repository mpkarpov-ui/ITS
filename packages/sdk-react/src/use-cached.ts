import { useEffect, useState } from 'preact/hooks';
import type { SubjectPayload, SubjectUnion } from '@its/contracts/_subjects';
import { subscribe as wsSubscribe } from './ws-bridge';
import {
  _cacheGet,
  _cacheMatches,
  _cacheSet,
  _cacheSubscribe,
  type CacheEntry,
} from './cache';
import type { StreamResult } from './use-stream';

// Like useStream, but warm-starts from the shared last-value cache. On a cache
// hit (exact, or the freshest wildcard match) the first render returns it;
// otherwise it behaves identically to useStream. A strict superset, safe to
// swap in for any useStream call site (uncached subjects just never warm-start).
export function useCached<S extends SubjectUnion>(
  subject: S,
): StreamResult<SubjectPayload<S>> {
  const [state, setState] = useState<StreamResult<SubjectPayload<S>>>(() =>
    initialFromCache<SubjectPayload<S>>(subject),
  );

  useEffect(() => {
    // Re-evaluate the cache on subject change (the useState initial fires once).
    setState(initialFromCache<SubjectPayload<S>>(subject));
    // Feed the cache too, so future mounts warm-start from this subscription's
    // traffic even if the populator wasn't first to subscribe.
    return wsSubscribe(subject, (v, concreteSubject) => {
      _cacheSet(concreteSubject, v);
      setState({ value: v as SubjectPayload<S>, lastSeen: Date.now() });
    });
  }, [subject]);

  return state;
}

function initialFromCache<T>(subject: string): StreamResult<T> {
  // Exact-match cache hit first (cheaper than scanning).
  const exact = _cacheGet(subject);
  if (exact) return { value: exact.value as T, lastSeen: exact.lastSeen };
  // Wildcard fallback: pick the freshest entry matching the pattern.
  const matches = _cacheMatches(subject);
  if (matches.length === 0) return { value: null, lastSeen: null };
  let latest: CacheEntry = matches[0][1];
  for (const [, entry] of matches) {
    if (entry.lastSeen > latest.lastSeen) latest = entry;
  }
  return { value: latest.value as T, lastSeen: latest.lastSeen };
}

// Re-exported for the cache plugin; useCached itself updates via wsSubscribe.
void _cacheSubscribe;
