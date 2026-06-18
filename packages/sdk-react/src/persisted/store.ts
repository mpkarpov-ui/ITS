// Plugin-internal persisted state. Same shape as the settings store but a
// distinct `its.persisted.*` prefix: useSetting is for user-facing preferences,
// usePersisted is for plugin-internal cache/scratch that's never user-visible.
// Telemetry continuity is a third flavour, handled in the WS bridge.

type Listener = () => void;

const STORAGE_PREFIX = 'its.persisted.';
const listeners = new Set<Listener>();
const cache = new Map<string, unknown>();

function storageKey(scope: string, key: string): string {
  return `${STORAGE_PREFIX}${scope}.${key}`;
}

export function getPersisted<T>(scope: string, key: string, defaultValue: T): T {
  const k = storageKey(scope, key);
  if (cache.has(k)) return cache.get(k) as T;
  try {
    const raw = localStorage.getItem(k);
    if (raw === null) return defaultValue;
    const parsed = JSON.parse(raw) as T;
    cache.set(k, parsed);
    return parsed;
  } catch {
    return defaultValue;
  }
}

export function setPersisted<T>(scope: string, key: string, value: T): void {
  const k = storageKey(scope, key);
  cache.set(k, value);
  try {
    localStorage.setItem(k, JSON.stringify(value));
  } catch {
    // Quota / private mode / serialization failure. The cache update and
    // notification below still run so the session reflects the change.
  }
  for (const l of listeners) l();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (!e.key || !e.key.startsWith(STORAGE_PREFIX)) return;
    cache.delete(e.key);
    for (const l of listeners) l();
  });
}
