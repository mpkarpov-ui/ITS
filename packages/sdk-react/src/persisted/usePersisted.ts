// React hook over the persisted store. Mirrors useSetting's API:
//   const [value, setValue] = usePersisted('scope', 'key', defaultValue);
//
// Same [value, setter] shape as useState. Re-renders when the
// scope/key value changes (locally or via cross-tab storage events).

import { useEffect, useState } from 'preact/hooks';
import { getPersisted, setPersisted, subscribe } from './store';

export function usePersisted<T>(
  scope: string,
  key: string,
  defaultValue: T,
): [T, (value: T) => void] {
  const [, force] = useState(0);
  useEffect(() => subscribe(() => force((n) => n + 1)), []);
  return [
    getPersisted(scope, key, defaultValue),
    (value: T) => setPersisted(scope, key, value),
  ];
}
