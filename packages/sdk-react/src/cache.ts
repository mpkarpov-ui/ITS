// Shared last-value cache keyed by concrete NATS subject. Plugins opt subjects
// in via [[cache]] in their manifest; the cache populator subscribes to each at
// app load. Consumers read through useCached / useCachedMap, which warm-start
// from the cache and stay fresh via live subscriptions. Module-level singleton,
// not a hook; the hooks wrap it.

export interface CacheEntry {
  value: unknown;
  lastSeen: number;
}

const cache = new Map<string, CacheEntry>();
const listeners = new Map<string, Set<(entry: CacheEntry) => void>>();
// Pattern listeners that fire for any concrete subject matching the pattern.
const wildcardListeners = new Map<
  string,
  Set<(concreteSubject: string, entry: CacheEntry) => void>
>();

export function _cacheSet(concreteSubject: string, value: unknown): void {
  const entry: CacheEntry = { value, lastSeen: Date.now() };
  cache.set(concreteSubject, entry);
  const ls = listeners.get(concreteSubject);
  if (ls) for (const cb of ls) cb(entry);
  for (const [pattern, cbs] of wildcardListeners) {
    if (subjectMatches(pattern, concreteSubject)) {
      for (const cb of cbs) cb(concreteSubject, entry);
    }
  }
}

export function _cacheGet(concreteSubject: string): CacheEntry | null {
  return cache.get(concreteSubject) ?? null;
}

export function _cacheMatches(pattern: string): Array<[string, CacheEntry]> {
  const out: Array<[string, CacheEntry]> = [];
  for (const [subj, entry] of cache) {
    if (subjectMatches(pattern, subj)) out.push([subj, entry]);
  }
  return out;
}

export function _cacheSubscribe(
  concreteSubject: string,
  cb: (entry: CacheEntry) => void,
): () => void {
  const ls = listeners.get(concreteSubject) ?? new Set();
  ls.add(cb);
  listeners.set(concreteSubject, ls);
  return () => {
    ls.delete(cb);
    if (ls.size === 0) listeners.delete(concreteSubject);
  };
}

export function _cacheSubscribeWildcard(
  pattern: string,
  cb: (concreteSubject: string, entry: CacheEntry) => void,
): () => void {
  const ls = wildcardListeners.get(pattern) ?? new Set();
  ls.add(cb);
  wildcardListeners.set(pattern, ls);
  return () => {
    ls.delete(cb);
    if (ls.size === 0) wildcardListeners.delete(pattern);
  };
}

// NATS subject matching: * matches one token, > matches the remainder.
export function subjectMatches(pattern: string, subject: string): boolean {
  const p = pattern.split('.');
  const s = subject.split('.');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '>') return true;
    if (i >= s.length) return false;
    if (p[i] === '*') continue;
    if (p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}
