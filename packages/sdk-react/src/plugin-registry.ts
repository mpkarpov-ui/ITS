// Plugin registry: cached fetch of /_plugins plus helpers for mount lookups.

export interface UIMount {
  target: string;
  component: string;
  route: string | null;
  title: string | null;
}

export interface CacheSpec {
  // Stream name or path suffix; the populator subscribes to
  // `its.<plugin>.*.<subject>` (instance_key wildcarded).
  subject: string;
}

export interface PublishSpec {
  // Concrete subject is `its.<plugin>.<instance_key>.<path ?? stream>`.
  stream: string;
  // Sub-path under instance_key, may contain `{placeholder}` segments filled at
  // publish time. null means just the stream name.
  path: string | null;
}

export interface PluginInfo {
  id: string;
  version: string;
  description: string | null;
  cache: CacheSpec[];
  publishes: PublishSpec[];
  ui: {
    entry: string;
    // Nav-rail icon name; absent/unknown falls back to a derived monogram.
    icon?: string | null;
    // Nav-rail sort weight; higher floats toward the top (default 0).
    priority?: number;
    mounts: UIMount[];
  } | null;
}

// Fetch + parse JSON, with a clear error when the server returned HTML (the
// dev-mode catch-all redirects unregistered endpoints, so a non-JSON response
// usually means the server needs a restart to pick up new routes).
async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} responded ${r.status}`);
  const ct = r.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    throw new Error(
      `${url} returned non-JSON (content-type=${ct || 'unknown'}). ` +
      `The endpoint likely isn't registered; restart the server to pick up new routes.`,
    );
  }
  return (await r.json()) as T;
}

let cachePromise: Promise<PluginInfo[]> | null = null;

export function getPlugins(): Promise<PluginInfo[]> {
  if (!cachePromise) cachePromise = getJson<PluginInfo[]>('/_plugins');
  return cachePromise;
}

export interface PlatformMeta {
  version: string;
  started_at_ms: number;
  plugin_count: number;
  // True when served by `its repeater`: the WS bridge rejects writes, so
  // plugins can hide commanding affordances. Optional for back-compat.
  readonly?: boolean;
}

let metaPromise: Promise<PlatformMeta> | null = null;

export function getMeta(): Promise<PlatformMeta> {
  if (!metaPromise) metaPromise = getJson<PlatformMeta>('/_meta');
  return metaPromise;
}

export interface PlatformStats {
  // Server wall-clock at response time. cpu/mem/uptime are server-authoritative;
  // the dashboard ticks the clock off Date.now() for smoothness.
  now_ms: number;
  uptime_s: number;
  cpu_percent: number;
  mem_mb: number;
}

export function getStats(): Promise<PlatformStats> {
  // Fresh fetch every time; these are dynamic.
  return getJson<PlatformStats>('/_stats');
}

export interface MountInfo {
  pluginId: string;
  mount: UIMount;
}

export async function getMountsForTarget(target: string): Promise<MountInfo[]> {
  const plugins = await getPlugins();
  const result: MountInfo[] = [];
  for (const p of plugins) {
    if (!p.ui) continue;
    for (const mount of p.ui.mounts) {
      if (mount.target === target) result.push({ pluginId: p.id, mount });
    }
  }
  return result;
}
