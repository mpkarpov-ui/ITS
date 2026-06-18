import { useCallback, useEffect, useState } from 'preact/hooks';
import type { GlobalDescriptor } from '@its/contracts/_globals';
import { kvSet, kvWatch } from './ws-bridge';

// Subscribes a component to a typed shared KV value. Returns
// [value, setValue, {ready}]: value is null until the key is set, setValue is a
// typed imperative write, ready flips true once the initial value (or null
// sentinel) arrives.
//
//   const [timer, setTimer] = useGlobal(globals.commandingView.timer);
//   setTimer({ ...timer, paused: !timer.paused });
export function useGlobal<T>(
  descriptor: GlobalDescriptor<T>,
): [T | null, (value: T) => void, { ready: boolean }] {
  const { key } = descriptor;
  const [value, setValue] = useState<T | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(false);
    return kvWatch(key, (next) => {
      setValue(next as T | null);
      setReady(true);
    });
  }, [key]);

  const set = useCallback((next: T) => kvSet(key, next), [key]);
  return [value, set, { ready }];
}
