// Broadcast overlay, mounted at /overlay as an OBS browser source. One
// component renders every mode, selected by the ?mode= query param so the
// manifest needs only a single tab mount (no wildcard routes). Body goes
// transparent on mount so OBS composites over the live feed. Mission text
// comes from the active format YAML, with defaults so OBS isn't blank during
// setup. Modes: default, idle, pre, goodbye, facts, sponsors.

import { useEffect } from 'preact/hooks';
import { lazy, Suspense } from 'preact/compat';
import { useSearch } from 'wouter';
import { subjects, useStream } from '@its/sdk-react';
import { PassiveTimer } from './PassiveTimer';
import { Timeline, DEFAULT_TIMELINE } from './Timeline';
import { NameTag } from './NameTag';
import { SpotStrip } from './SpotStrip';
import { IdleScreen } from './modes/Idle';
import { FactsScreen } from './modes/Facts';
import { SponsorsScreen } from './modes/Sponsors';
import { useActiveFormat } from '../formats/useFormat';
import './overlay.css';

// Lazy so cesium (~3MB) only loads for ?mode=map, not every overlay chunk.
const MapScreen = lazy(() => import('./modes/Map'));

const FALLBACK_PROGRAM_NAME = 'ISS';
const FALLBACK_BOOSTER_TARGET = 'm007';
// Camera home for the map overlay when the format doesn't pin one (legacy GSS
// launch site).
const DEFAULT_LAUNCH_SITE = { lat: 40.388527, lon: -87.51416 };

type Mode = 'default' | 'idle' | 'pre' | 'goodbye' | 'facts' | 'sponsors' | 'map';

function parseMode(search: string): Mode {
  const params = new URLSearchParams(search);
  const raw = params.get('mode');
  if (
    raw === 'idle' || raw === 'pre' || raw === 'goodbye' ||
    raw === 'facts' || raw === 'sponsors' || raw === 'map'
  ) {
    return raw;
  }
  return 'default';
}

export function Overlay() {
  const search = useSearch();
  const mode = parseMode(search);
  const { format } = useActiveFormat();

  // Active-format values, each with a fallback so a partial YAML still renders.
  const programName = format?.program_name || FALLBACK_PROGRAM_NAME;
  const timelineRows = format?.timeline && format.timeline.length > 0
    ? format.timeline
    : DEFAULT_TIMELINE;
  const facts = format?.fun_facts ?? [];
  const sponsors = format?.sponsors ?? [];
  const boosterTarget = format?.booster_target ?? FALLBACK_BOOSTER_TARGET;
  const sustainerTarget = format?.sustainer_target;
  const launchSite = format?.launch_site ?? DEFAULT_LAUNCH_SITE;

  // Watch booster FSM here so PassiveTimer can switch STANDBY/T-clock on launch.
  const booster = useStream(subjects.gssBridge.tlm(boosterTarget));
  const hasLaunched = (booster.value?.FSM_State ?? -1) > 2;

  useEffect(() => {
    // Both html and body carry the theme's opaque background; the page canvas
    // takes html's, so clear it there too or OBS never sees transparency.
    document.documentElement.classList.add('iss-live-overlay-host');
    document.body.classList.add('iss-live-overlay-host');
    return () => {
      document.documentElement.classList.remove('iss-live-overlay-host');
      document.body.classList.remove('iss-live-overlay-host');
    };
  }, []);

  return (
    <div className="iss-live-overlay-root">
      {mode === 'default' && (
        <>
          <PassiveTimer programName={programName} hasLaunched={hasLaunched} />
          <Timeline programName={programName} rows={timelineRows} />
          <SpotStrip boosterTarget={boosterTarget} sustainerTarget={sustainerTarget} />
          <NameTag />
        </>
      )}
      {mode === 'idle' && <IdleScreen variant="idle" />}
      {mode === 'pre' && <IdleScreen variant="pre" />}
      {mode === 'goodbye' && <IdleScreen variant="goodbye" />}
      {mode === 'facts' && <FactsScreen facts={facts} />}
      {mode === 'sponsors' && <SponsorsScreen sponsors={sponsors} />}
      {mode === 'map' && (
        <Suspense fallback={null}>
          <MapScreen
            search={search}
            boosterTarget={boosterTarget}
            sustainerTarget={sustainerTarget}
            launchSite={launchSite}
          />
        </Suspense>
      )}
    </div>
  );
}
