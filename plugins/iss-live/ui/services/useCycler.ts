// Read-only hook over the scene-cycler singleton; re-renders on each change.

import { useEffect, useState } from 'preact/hooks';
import { sceneCycler, type CyclerState } from './cycler';

export function useCycler(): CyclerState {
  const [state, setState] = useState<CyclerState>(sceneCycler.getState());
  useEffect(() => sceneCycler.subscribe(setState), []);
  return state;
}
