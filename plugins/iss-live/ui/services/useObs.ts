// Read-only hook over the OBS singleton; re-renders on each state event.
// Connection management lives in the Sidebar, not here.

import { useEffect, useState } from 'preact/hooks';
import { obsService, type ObsState } from './obs';

export function useObs(): ObsState {
  const [state, setState] = useState<ObsState>(obsService.getState());
  useEffect(() => obsService.subscribe(setState), []);
  return state;
}
