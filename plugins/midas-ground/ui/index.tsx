// Named exports the host's TabContent resolves per manifest route. Flight and
// Commanding share one eager chunk; MapView is lazy() since cesium (~3MB)
// shouldn't sit on the hot path. Each export wraps the view in TargetProvider
// so useTarget()/useMidasTlm() resolve.

import { Suspense, lazy } from 'preact/compat';
import { Loading, clearHistories, registerCommand } from '@its/sdk-react';
import { CommandingView as RawCommandingView } from './CommandingView';
import { FlightView as RawFlightView } from './FlightView';
import { TargetProvider } from './TargetContext';

const MapViewImpl = lazy(() => import('./MapView'));

// Registered at module load, so it appears in the palette once midas-ground's
// chunk loads (first nav to /flight, /commanding, or /map).
registerCommand({
  id: 'midas-ground.clear-cached-data',
  source: 'midas-ground',
  title: 'Clear TLM Cache',
  hint: 'Wipes Telemetry History',
  action: () => {
    clearHistories();
  },
});

// Settings schema lives in ./settings.ts so /settings can load it without this chunk.

export function FlightView() {
  return (
    <TargetProvider>
      <RawFlightView />
    </TargetProvider>
  );
}

export function CommandingView() {
  return (
    <TargetProvider>
      <RawCommandingView />
    </TargetProvider>
  );
}

export function MapView() {
  return (
    <TargetProvider>
      <Suspense fallback={<Loading pluginId="midas-ground" sublabel="map" />}>
        <MapViewImpl />
      </Suspense>
    </TargetProvider>
  );
}
