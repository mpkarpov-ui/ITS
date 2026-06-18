// Populates the shared subject cache at SDK load: fetches /_plugins, walks each
// plugin's [[cache]] declarations, and opens a long-lived subscription per
// declared subject (instance_key wildcarded). Arriving messages land in the
// cache via _cacheSet so useCached / useCachedMap warm-start on first mount.

import { getPlugins, type PluginInfo } from './plugin-registry';
import { subscribe } from './ws-bridge';
import { _cacheSet } from './cache';

let started = false;

export function _initCachePopulator(): void {
  if (started) return;
  started = true;
  getPlugins()
    .then((plugins: PluginInfo[]) => {
      for (const p of plugins) {
        for (const entry of p.cache ?? []) {
          // Wildcard instance_key; the cache indexes by concrete subject so
          // per-instance entries stay distinct.
          const pattern = `its.${p.id}.*.${entry.subject}`;
          subscribe(pattern, (value, concreteSubject) => {
            _cacheSet(concreteSubject, value);
          });
        }
      }
    })
    .catch((e) => {
      // eslint-disable-next-line no-console
      console.warn('[sdk-react] cache populator: failed to fetch /_plugins', e);
    });
}
