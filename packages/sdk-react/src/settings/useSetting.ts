// useSetting('scope', 'key', default) -> [value, setter], same shape as
// useState. The store has a flat listener set, so any setting change re-renders;
// the value is read by key so equal values don't propagate further.

import { useEffect, useState } from 'preact/hooks';
import { getSetting, setSetting, subscribe } from './store';

export function useSetting<T>(
  scope: string,
  key: string,
  defaultValue: T,
): [T, (value: T) => void] {
  // Force-render tick; the value stays out of state so we always read the
  // latest from the store cache, with no stale-closure risk.
  const [, force] = useState(0);
  useEffect(() => subscribe(() => force((n) => n + 1)), []);
  return [
    getSetting(scope, key, defaultValue),
    (value: T) => setSetting(scope, key, value),
  ];
}
