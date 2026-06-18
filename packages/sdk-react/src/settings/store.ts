// Singleton settings store backed by localStorage. Keys are namespaced
// `its.settings.<scope>.<key>` so plugins don't collide; values are JSON so
// types round-trip. Listeners fire on set() and on the browser `storage` event,
// so another tab's change propagates without reload.

type Listener = () => void;

const STORAGE_PREFIX = 'its.settings.';
const listeners = new Set<Listener>();
const cache = new Map<string, unknown>();

function storageKey(scope: string, key: string): string {
  return `${STORAGE_PREFIX}${scope}.${key}`;
}

export function getSetting<T>(scope: string, key: string, defaultValue: T): T {
  const k = storageKey(scope, key);
  if (cache.has(k)) return cache.get(k) as T;
  try {
    const raw = localStorage.getItem(k);
    if (raw === null) return defaultValue;
    const parsed = JSON.parse(raw) as T;
    cache.set(k, parsed);
    return parsed;
  } catch {
    // Private mode or corrupt JSON; treat as missing.
    return defaultValue;
  }
}

export function setSetting<T>(scope: string, key: string, value: T): void {
  const k = storageKey(scope, key);
  cache.set(k, value);
  try {
    localStorage.setItem(k, JSON.stringify(value));
  } catch {
    // Persistence failed (private mode / quota). The cache update and listener
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

// Cross-tab sync: another tab's setItem fires `storage` here. Invalidate the
// cached key so the next read re-fetches it, then notify local listeners.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (!e.key || !e.key.startsWith(STORAGE_PREFIX)) return;
    cache.delete(e.key);
    for (const l of listeners) l();
  });
}
