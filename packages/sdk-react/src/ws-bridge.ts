// One shared WebSocket to /ws/bus, multiplexing subscriptions, commands, and
// KV. Module-level singleton so N hooks don't open N sockets. Per-subject
// histories and KV values are mirrored to localStorage so a reload keeps the
// telemetry trail and avoids a null-flash. See docs/persistence.md.

import { getSetting, subscribe as subscribeSettings } from './settings/store';
import { subjectMatches } from './cache';

type SubscribeFrame = { action: 'subscribe'; subject: string };
type UnsubscribeFrame = { action: 'unsubscribe'; subject: string };
type PublishFrame = { action: 'publish'; subject: string; payload: unknown };
type RequestFrame = {
  action: 'request';
  id: string;
  subject: string;
  payload: unknown;
  timeout_s?: number;
};
type KvGetFrame = { action: 'kv_get'; id: string; key: string };
type KvSetFrame = { action: 'kv_set'; key: string; value: unknown };
type KvWatchStartFrame = { action: 'kv_watch_start'; key: string };
type KvWatchStopFrame = { action: 'kv_watch_stop'; key: string };
type ClientFrame =
  | SubscribeFrame
  | UnsubscribeFrame
  | PublishFrame
  | RequestFrame
  | KvGetFrame
  | KvSetFrame
  | KvWatchStartFrame
  | KvWatchStopFrame;

type StreamMessage = { subscription: string; subject: string; payload: unknown };
type RequestReply = { request_id: string; reply: unknown };
type RequestError = { request_id: string; error: string };
type KvGetReply = { kv_id: string; value: unknown };
type KvGetError = { kv_id: string; error: string };
type KvUpdate = { kv_key: string; value: unknown };
type ServerMessage =
  | StreamMessage
  | RequestReply
  | RequestError
  | KvGetReply
  | KvGetError
  | KvUpdate;

let ws: WebSocket | null = null;
let pending: ClientFrame[] = [];
// Subscriber callbacks get (payload, concreteSubject). The concrete subject
// matters for wildcard subscriptions; the cache layer uses it to key
// per-instance entries when a subscription wildcards the instance_key.
const subscribers = new Map<
  string,
  Set<(value: unknown, concreteSubject: string) => void>
>();
const requestResolvers = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();
const kvGetResolvers = new Map<
  string,
  { resolve: (v: unknown | null) => void; reject: (e: Error) => void }
>();
const kvWatchers = new Map<string, Set<(value: unknown | null) => void>>();

// Per-subject ring buffer feeding useHistory, capped so a long session stays
// bounded across many parallel subjects.
const HISTORY_CAP = 1000;
const histories = new Map<string, unknown[]>();
const historyListeners = new Map<string, Set<(buf: unknown[]) => void>>();
// Fired only when the SET of cached subjects changes (first message of a new
// subject, or a clear). Not fired on ordinary pushes, so useKnownSubjects
// re-renders on discovery/clear rather than at telemetry cadence.
const subjectSetListeners = new Set<() => void>();
// Last-push wall-clock per subject, kept separate from the value buffer so
// useStream's warm-start hands back a real lastSeen and useStaleAfter ages a
// cached value correctly.
const lastUpdatedAt = new Map<string, number>();

// Persistence: telemetry continuity across reloads.
const PERSIST_KEY = 'its.telemetry.cache';
const PERSIST_VERSION = 1;
const PERSIST_DEBOUNCE_MS = 2000;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistDisabled = false;

// Samples to keep per subject when persisting. 0 = off, -1 = unlimited (capped
// at HISTORY_CAP). Scoped under midas-ground, the primary telemetry consumer;
// every other plugin's history shares the same cache.
function currentRetention(): number {
  // Stored as a string under the enum setting; coerce here.
  const raw = getSetting<string>('midas-ground', 'telemetryRetention', '100');
  const n = Number(raw);
  return Number.isFinite(n) ? n : 100;
}

function loadFromStorage(): void {
  const cap = currentRetention();
  if (cap === 0) return;
  let raw: string | null;
  try {
    raw = localStorage.getItem(PERSIST_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as {
      version?: number;
      subjects?: Record<string, unknown[]>;
      lastSeen?: Record<string, number>;
    };
    if (parsed.version !== PERSIST_VERSION) return;
    const effectiveCap =
      cap === -1 ? HISTORY_CAP : Math.min(cap, HISTORY_CAP);
    for (const [subject, buf] of Object.entries(parsed.subjects ?? {})) {
      if (!Array.isArray(buf) || buf.length === 0) continue;
      // Trim to current cap in case the operator lowered it between sessions.
      const trimmed = buf.length > effectiveCap ? buf.slice(-effectiveCap) : buf;
      histories.set(subject, trimmed.slice());
    }
    for (const [subject, ts] of Object.entries(parsed.lastSeen ?? {})) {
      if (typeof ts === 'number') lastUpdatedAt.set(subject, ts);
    }
  } catch {
    // Corrupt JSON; ignore and rebuild from live data.
  }
}

function flushToStorage(): void {
  persistTimer = null;
  if (persistDisabled) return;
  const cap = currentRetention();
  if (cap === 0) return;
  const effectiveCap =
    cap === -1 ? HISTORY_CAP : Math.min(cap, HISTORY_CAP);
  const subjects: Record<string, unknown[]> = {};
  for (const [subject, buf] of histories) {
    if (buf.length === 0) continue;
    subjects[subject] =
      buf.length > effectiveCap ? buf.slice(-effectiveCap) : buf.slice();
  }
  const lastSeen: Record<string, number> = {};
  for (const [subject, ts] of lastUpdatedAt) lastSeen[subject] = ts;
  const payload = JSON.stringify({
    version: PERSIST_VERSION,
    subjects,
    lastSeen,
  });
  try {
    localStorage.setItem(PERSIST_KEY, payload);
  } catch (err) {
    // Quota exceeded or similar: disable for the session so we don't thrash.
    // The in-memory store keeps working; persistence retries next page load.
    persistDisabled = true;
    // eslint-disable-next-line no-console
    console.warn(
      '[its] telemetry persistence disabled for the session:',
      err,
    );
  }
}

function schedulePersist(): void {
  if (persistDisabled) return;
  if (persistTimer !== null) return;
  persistTimer = setTimeout(flushToStorage, PERSIST_DEBOUNCE_MS);
}

// KV cache: useGlobal continuity across reloads. Server-side KV values survive
// restarts, but on browser reload useGlobal would flash null until the WS
// reconnects and the server pushes the initial value. We mirror values to
// localStorage and fire kvWatch synchronously from the cache, so the component
// renders last-known state immediately; the server's push then reconciles if
// another operator changed the value while this tab was offline.
const KV_CACHE_KEY = 'its.kv.cache';
const KV_CACHE_VERSION = 1;
const kvCache = new Map<string, unknown>();
let kvCacheDisabled = false;

function loadKvCache(): void {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KV_CACHE_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as {
      version?: number;
      entries?: Record<string, unknown>;
    };
    if (parsed.version !== KV_CACHE_VERSION) return;
    for (const [k, v] of Object.entries(parsed.entries ?? {})) {
      kvCache.set(k, v);
    }
  } catch {
    // Corrupt blob; ignore, live updates repopulate.
  }
}

function flushKvCache(): void {
  if (kvCacheDisabled) return;
  const entries: Record<string, unknown> = {};
  for (const [k, v] of kvCache) entries[k] = v;
  try {
    localStorage.setItem(
      KV_CACHE_KEY,
      JSON.stringify({ version: KV_CACHE_VERSION, entries }),
    );
  } catch (err) {
    kvCacheDisabled = true;
    // eslint-disable-next-line no-console
    console.warn('[its] KV cache disabled for the session:', err);
  }
}

// Hydrate at module load, before any subscriber attaches, so the first
// useStream / useHistory / useGlobal render sees warm data.
loadFromStorage();
loadKvCache();

// React to retention setting changes mid-session.
subscribeSettings(() => {
  if (currentRetention() === 0) {
    // Off: cancel any pending write and drop the on-disk blob so we don't
    // preserve data the operator just opted out of.
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    try {
      localStorage.removeItem(PERSIST_KEY);
    } catch {}
  } else if (persistDisabled) {
    persistDisabled = false;
  }
});

function pushHistory(subject: string, value: unknown): void {
  let buf = histories.get(subject);
  const isNewSubject = !buf;
  if (!buf) {
    buf = [];
    histories.set(subject, buf);
  }
  buf.push(value);
  if (buf.length > HISTORY_CAP) buf.shift();
  lastUpdatedAt.set(subject, Date.now());
  const listeners = historyListeners.get(subject);
  if (listeners) for (const cb of listeners) cb(buf);
  if (isNewSubject) for (const cb of subjectSetListeners) cb();
  schedulePersist();
}

// Clears every per-subject buffer and last-seen timestamp, drops the persisted
// cache, and notifies subscribers with empty buffers so mounted useHistory
// consumers render zero rows. Subscriptions stay open; new messages keep flowing.
export function clearHistories(): void {
  histories.clear();
  lastUpdatedAt.clear();
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    localStorage.removeItem(PERSIST_KEY);
  } catch {}
  for (const [, listeners] of historyListeners) {
    for (const cb of listeners) cb([]);
  }
  for (const cb of subjectSetListeners) cb();
}

// Subjects currently in the telemetry cache, optionally filtered to a NATS
// pattern. These are the subscription patterns under which messages have
// accumulated, surviving reload via the persisted blob. Pairs with
// subscribeKnownSubjects for reactivity.
export function knownSubjects(pattern?: string): string[] {
  const keys = [...histories.keys()];
  return pattern ? keys.filter((k) => subjectMatches(pattern, k)) : keys;
}

// Notified when the cached-subject set changes. Returns an unsubscribe.
// Does not fire on ordinary pushes.
export function subscribeKnownSubjects(cb: () => void): () => void {
  subjectSetListeners.add(cb);
  return () => {
    subjectSetListeners.delete(cb);
  };
}

// Last value pushed for `subject` plus its arrival time, or null if never seen.
// useStream uses this to warm-start when resubscribing to a subject another
// listener has already been accumulating.
export function getLastValue(
  subject: string,
): { value: unknown; lastSeen: number } | null {
  const buf = histories.get(subject);
  const ts = lastUpdatedAt.get(subject);
  if (!buf || buf.length === 0 || ts === undefined) return null;
  return { value: buf[buf.length - 1], lastSeen: ts };
}

function ensureWs(): WebSocket {
  if (ws) return ws;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${window.location.host}/ws/bus`);
  ws.addEventListener('open', () => {
    for (const frame of pending) ws!.send(JSON.stringify(frame));
    pending = [];
  });
  ws.addEventListener('message', (ev) => {
    const data = JSON.parse(ev.data) as ServerMessage;
    if ('request_id' in data) {
      const handle = requestResolvers.get(data.request_id);
      if (!handle) return;
      requestResolvers.delete(data.request_id);
      if ('error' in data) handle.reject(new Error(data.error));
      else handle.resolve(data.reply);
      return;
    }
    if ('kv_id' in data) {
      const handle = kvGetResolvers.get(data.kv_id);
      if (!handle) return;
      kvGetResolvers.delete(data.kv_id);
      if ('error' in data) handle.reject(new Error(data.error));
      else handle.resolve(data.value as unknown | null);
      return;
    }
    if ('kv_key' in data) {
      const value = data.value as unknown | null;
      // Cache non-null values for synchronous hydration next load. Skip nulls
      // (key unset) so we don't echo a stale unset reading over real state.
      if (value !== null) {
        kvCache.set(data.kv_key, value);
        flushKvCache();
      }
      const listeners = kvWatchers.get(data.kv_key);
      if (listeners) for (const cb of listeners) cb(value);
      return;
    }
    // Route by `subscription` (the pattern we subscribed with), not the
    // concrete `subject`, so wildcard subscribers match. Pass the concrete
    // subject through for callers (the cache) that need it.
    pushHistory(data.subscription, data.payload);
    const cbs = subscribers.get(data.subscription);
    if (cbs) for (const cb of cbs) cb(data.payload, data.subject);
  });
  ws.addEventListener('close', () => {
    ws = null;
    // Fail in-flight requests so awaiters don't hang.
    for (const { reject } of requestResolvers.values()) {
      reject(new Error('websocket closed'));
    }
    requestResolvers.clear();
    for (const { reject } of kvGetResolvers.values()) {
      reject(new Error('websocket closed'));
    }
    kvGetResolvers.clear();
  });
  return ws;
}

function send(frame: ClientFrame): void {
  const sock = ensureWs();
  if (sock.readyState === WebSocket.OPEN) {
    sock.send(JSON.stringify(frame));
  } else {
    pending.push(frame);
  }
}

export function subscribe(
  subject: string,
  cb: (value: unknown, concreteSubject: string) => void,
): () => void {
  const cbs = subscribers.get(subject) ?? new Set();
  const isFirstSubscriber = cbs.size === 0;
  cbs.add(cb);
  subscribers.set(subject, cbs);
  if (isFirstSubscriber) send({ action: 'subscribe', subject });
  return () => {
    cbs.delete(cb);
    if (cbs.size === 0) {
      subscribers.delete(subject);
      send({ action: 'unsubscribe', subject });
    }
  };
}

export function publish(subject: string, payload: unknown): void {
  send({ action: 'publish', subject, payload });
}

export function subscribeHistory(
  subject: string,
  cb: (buf: unknown[]) => void,
): () => void {
  // Drive a bus-level subscription with a no-op so messages accumulate even
  // when no useStream is mounted.
  const noop = () => {};
  const unsubBus = subscribe(subject, noop);
  const listeners = historyListeners.get(subject) ?? new Set();
  listeners.add(cb);
  historyListeners.set(subject, listeners);
  const buf = histories.get(subject);
  if (buf && buf.length > 0) cb(buf);
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) historyListeners.delete(subject);
    unsubBus();
  };
}

export function kvSet(key: string, value: unknown): void {
  send({ action: 'kv_set', key, value });
}

export function kvGet(key: string): Promise<unknown | null> {
  const id = newId();
  return new Promise((resolve, reject) => {
    kvGetResolvers.set(id, { resolve, reject });
    send({ action: 'kv_get', id, key });
  });
}

export function kvWatch(
  key: string,
  cb: (value: unknown | null) => void,
): () => void {
  const listeners = kvWatchers.get(key) ?? new Set();
  const isFirst = listeners.size === 0;
  listeners.add(cb);
  kvWatchers.set(key, listeners);
  if (isFirst) send({ action: 'kv_watch_start', key });
  // Synchronous cache fire kills the null-flash on reload; the server's
  // initial value follows over the WS and reconciles any offline change.
  if (kvCache.has(key)) cb(kvCache.get(key) ?? null);
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) {
      kvWatchers.delete(key);
      send({ action: 'kv_watch_stop', key });
    }
  };
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function request(
  subject: string,
  payload: unknown,
  timeout_s = 5,
): Promise<unknown> {
  const id = newId();
  return new Promise((resolve, reject) => {
    requestResolvers.set(id, { resolve, reject });
    send({ action: 'request', id, subject, payload, timeout_s });
  });
}
