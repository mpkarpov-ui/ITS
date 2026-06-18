export { useStream } from './use-stream';
export type { StreamResult } from './use-stream';
export { useStaleAfter } from './use-stale-after';
export { useCached } from './use-cached';
export { useCachedMap } from './use-cached-map';
export {
  _cacheSet,
  _cacheGet,
  _cacheMatches,
  _cacheSubscribe,
  _cacheSubscribeWildcard,
} from './cache';
export type { CacheEntry } from './cache';
export { useHistory } from './use-history';
export { useCommand } from './use-command';
export { useGlobal } from './use-global';
// Lower-level bridge helpers: subscribeHistory for stream-style accumulation,
// subscribe for raw per-message access, clearHistories to wipe local trails.
export { subscribe, subscribeHistory, clearHistories, publish } from './ws-bridge';
// Discover subjects that have telemetry in the local cache. knownSubjects is
// the one-shot read; useKnownSubjects is the reactive hook.
export { knownSubjects, subscribeKnownSubjects } from './ws-bridge';
export { useKnownSubjects } from './use-known-subjects';
export { MountPoint } from './MountPoint';
export { Loading } from './Loading';
export { defineSettings, specDefault } from './settings/schema';
export type { SettingSpec, SettingsSchema } from './settings/schema';
export { useSetting } from './settings/useSetting';
export { getSetting, setSetting, subscribe as subscribeSettings } from './settings/store';
export { usePersisted } from './persisted/usePersisted';
export { getPersisted, setPersisted, subscribe as subscribePersisted } from './persisted/store';
export {
  registerCommand,
  getPaletteCommands,
  subscribePaletteCommands,
} from './palette';
export type { PaletteCommand } from './palette';
export {
  getPlugins,
  getMeta,
  getStats,
  getMountsForTarget,
} from './plugin-registry';
export type {
  PluginInfo,
  PlatformMeta,
  PlatformStats,
  UIMount,
  MountInfo,
  CacheSpec,
  PublishSpec,
} from './plugin-registry';
export {
  loadPluginModule,
  discoveredPluginIds,
  loadPluginSettings,
  discoveredSettingsPluginIds,
} from './plugin-loader';
// Shared icon registry, same glyphs the nav rail draws.
export { Icon, hasIcon } from './icons';

// Re-export the generated subjects/commands/globals trees so plugins import
// them from the SDK root alongside the hooks.
export * from '@its/contracts/_subjects';
export * from '@its/contracts/_commands';
export * from '@its/contracts/_globals';

// Wire the runtime side of the globals descriptors. _globals.ts can't import
// the WS bridge directly (it would form a contracts <-> sdk-react cycle), so it
// exposes _installGlobalsBridge for us to call here.
import { _installGlobalsBridge } from '@its/contracts/_globals';
import { kvGet, kvSet } from './ws-bridge';
_installGlobalsBridge(kvGet, kvSet);

// Start the shared subject cache populator (reads [[cache]] manifest entries).
import { _initCachePopulator } from './cache-populator';
_initCachePopulator();
