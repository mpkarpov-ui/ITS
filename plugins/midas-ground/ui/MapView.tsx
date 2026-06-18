// 2.5D Columbus-View map, ported near-verbatim from GSS's MapView (LivePlotter).
// Trail uses a PolylineCollection primitive, not an Entity, to avoid the flash
// from entity-polyline reassignment. Lazy-loaded so cesium only fetches on /map.

import { useEffect, useRef, useState } from 'preact/hooks';
import {
  Viewer,
  Cartesian2,
  Cartesian3,
  Color,
  EllipsoidTerrainProvider,
  ImageryLayer,
  Ion,
  LabelStyle,
  Material,
  PolylineCollection,
  SceneMode,
  UrlTemplateImageryProvider,
  createWorldTerrainAsync,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';

import { useMidasTlm } from './hooks';
import { useTarget } from './TargetContext';
import { useUnits } from './units';
import { MidasNav } from './components/MidasNav';
import { fixName } from './components/midas';
import './MapView.css';

// Default camera target (GSS's launch site).
const DEFAULT_LAT = 40.388527;
const DEFAULT_LON = -87.51416;
const DEFAULT_DISTANCE_M = 10_000;
const DEFAULT_PITCH_DEG = -45;
const DEFAULT_HEADING_DEG = 0;
const TO_RAD = Math.PI / 180;

// Trail cap to bound memory. 1000 samples at 10Hz = ~100s, enough for boost+coast.
const TRAIL_MAX = 1000;

const MARKER_COLOR_CSS = '#ff5a5a';

export default function MapView() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const rocketEntityRef = useRef<any>(null);
  // PolylineCollection primitive: its Polyline's `positions` can be reassigned
  // without the flash the entity-polyline path produced.
  const trailLineRef = useRef<any>(null);
  const trailPositionsRef = useRef<Cartesian3[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tracking, setTracking] = useState(false);
  // Last packet with a good GPS fix. HUD + marker park here through brief NOFIX
  // blips (GPS drops fix for a beat without losing the rocket). Blanked only on
  // target switch.
  const [lastGoodFix, setLastGoodFix] = useState<{
    lat: number;
    lon: number;
    alt: number;
  } | null>(null);

  const { target } = useTarget();
  const { value: t } = useMidasTlm();

  useEffect(() => {
    if (!containerRef.current) return;
    // Register the Ion token before any Ion-hosted asset call. World terrain is
    // the only Ion asset; Esri imagery and the satellite tiles don't use Ion.
    const ionToken = (import.meta as any).env?.VITE_CESIUM_ION_TOKEN as
      | string
      | undefined;
    if (ionToken) {
      Ion.defaultAccessToken = ionToken;
    }

    let viewer: Viewer | null = null;
    try {
      const satellite = new UrlTemplateImageryProvider({
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        maximumLevel: 19,
      });
      // Detached div absorbs Cesium's credit chrome so it never renders.
      // Esri / Ion ToS ask for visible attribution: fine for a closed-LAN
      // dashboard, not for public distribution.
      const creditContainer = document.createElement('div');
      viewer = new Viewer(containerRef.current, {
        animation: false,
        timeline: false,
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        fullscreenButton: false,
        selectionIndicator: false,
        infoBox: false,
        creditContainer,
        baseLayer: new ImageryLayer(satellite, {}),
        // Flat ellipsoid first so the viewer is up immediately; world terrain
        // swaps in async below if an Ion token is set.
        terrainProvider: new EllipsoidTerrainProvider(),
      });
    } catch (err) {
      setError(`${err}`);
      return;
    }

    viewerRef.current = viewer;

    // Upgrade to Ion world terrain once it resolves; keep the flat ellipsoid
    // if the fetch fails (expired token, network).
    if (ionToken) {
      createWorldTerrainAsync()
        .then((terrain) => {
          if (viewer && !viewer.isDestroyed()) {
            viewer.terrainProvider = terrain;
          }
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('Cesium world terrain failed; staying flat:', err);
        });
    }

    // Columbus View: 2.5D unfolded globe you can tilt to read altitude.
    viewer.resolutionScale = window.devicePixelRatio || 1;
    viewer.scene.mode = SceneMode.COLUMBUS_VIEW;

    // Clamp zoom. Without a floor, Cesium flies the camera through the focal
    // point and lands the operator somewhere random on the far side.
    viewer.scene.screenSpaceCameraController.minimumZoomDistance = 1;
    viewer.scene.screenSpaceCameraController.maximumZoomDistance = 20_000_000;

    viewer.camera.setView({
      destination: Cartesian3.fromDegrees(
        DEFAULT_LON,
        DEFAULT_LAT,
        DEFAULT_DISTANCE_M,
      ),
      orientation: {
        heading: DEFAULT_HEADING_DEG * TO_RAD,
        pitch: DEFAULT_PITCH_DEG * TO_RAD,
        roll: 0,
      },
    });

    // Rocket marker (GSS visual): 10px dot, monospace label with thick black
    // outline so it reads on any background.
    rocketEntityRef.current = viewer.entities.add({
      name: 'rocket',
      position: Cartesian3.fromDegrees(DEFAULT_LON, DEFAULT_LAT, 0),
      point: {
        pixelSize: 10,
        color: Color.fromCssColorString(MARKER_COLOR_CSS),
      },
      label: {
        text: target,
        font: '28px monospace',
        scale: 0.65,
        fillColor: Color.WHITE,
        outlineColor: Color.BLACK,
        outlineWidth: 4,
        style: LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cartesian2(0, -20),
      },
      // Hidden until the first GPS fix, so no dot sits at (0,0) before data.
      show: false,
    });

    const trailCollection = viewer.scene.primitives.add(
      new PolylineCollection(),
    );
    trailLineRef.current = trailCollection.add({
      positions: [],
      width: 2,
      material: Material.fromType('Color', {
        color: Color.fromCssColorString(MARKER_COLOR_CSS).withAlpha(0.85),
      }),
    });

    return () => {
      const v = viewerRef.current;
      if (v && !v.isDestroyed()) {
        v.destroy();
      }
      viewerRef.current = null;
      rocketEntityRef.current = null;
      trailLineRef.current = null;
      trailPositionsRef.current = [];
    };
  }, []);

  // Marker label follows the target dropdown.
  useEffect(() => {
    const ent = rocketEntityRef.current;
    if (!ent || !ent.label) return;
    ent.label.text = target;
  }, [target]);

  // Reset trail + fix on target change so the new target doesn't inherit the
  // previous one's breadcrumbs.
  useEffect(() => {
    trailPositionsRef.current = [];
    if (trailLineRef.current) trailLineRef.current.positions = [];
    if (rocketEntityRef.current) rocketEntityRef.current.show = false;
    setLastGoodFix(null);
  }, [target]);

  // Bind each Tlm packet to the marker and append to the trail. NOFIX packets
  // are skipped (not hidden), so the marker holds its last position instead of
  // blinking off when GPS drops fix mid-stream.
  useEffect(() => {
    const ent = rocketEntityRef.current;
    const line = trailLineRef.current;
    if (!ent || !line || !t) return;
    const goodFix =
      t.gps_fixtype >= 2 &&
      Number.isFinite(t.latitude) &&
      Number.isFinite(t.longitude) &&
      (t.latitude !== 0 || t.longitude !== 0);
    if (!goodFix) return;
    setLastGoodFix({
      lat: t.latitude,
      lon: t.longitude,
      alt: t.altitude || 0,
    });
    const pos = Cartesian3.fromDegrees(
      t.longitude,
      t.latitude,
      t.altitude || 0,
    );
    ent.show = true;
    ent.position = pos;
    const arr = trailPositionsRef.current;
    arr.push(pos);
    while (arr.length > TRAIL_MAX) arr.shift();
    // Fresh array each tick; the PolylineCollection accepts reassignment without
    // the entity-path flicker.
    line.positions = arr.slice();
  }, [t]);

  // viewer.trackedEntity follows the rocket; toggling off leaves the camera put.
  useEffect(() => {
    const viewer = viewerRef.current;
    const ent = rocketEntityRef.current;
    if (!viewer || !ent) return;
    viewer.trackedEntity = tracking ? ent : undefined;
  }, [tracking]);

  // HUD lat/lon/alt stick to the last good fix; the fix field tracks live state
  // so a brief NOFIX still shows.
  const u = useUnits();
  const hasFix = lastGoodFix !== null;
  const lat = hasFix ? lastGoodFix.lat.toFixed(6) : '—';
  const lon = hasFix ? lastGoodFix.lon.toFixed(6) : '—';
  const alt = hasFix
    ? `${u.altitude.format(lastGoodFix.alt, 0)} ${u.altitude.unit}`
    : '—';
  const fix = t ? fixName(t.gps_fixtype) : '—';

  return (
    <div class="midas-page">
      <MidasNav />
      <div class="map-view">
        <div ref={containerRef} class="map-canvas" />
        {error && <div class="map-error">Map failed to load: {error}</div>}
        <div class="map-hud">
          <span class="map-hud-label">Target</span>
          <span class="map-hud-value">{target}</span>
          <span class="map-hud-sep">|</span>
          <span class="map-hud-label">Fix</span>
          <span class="map-hud-value">{fix}</span>
          <span class="map-hud-sep">|</span>
          <span class="map-hud-label">Lat</span>
          <span class="map-hud-value">{lat}</span>
          <span class="map-hud-label">Lon</span>
          <span class="map-hud-value">{lon}</span>
          <span class="map-hud-label">Alt</span>
          <span class="map-hud-value">{alt}</span>
          <button
            class={`map-hud-track ${tracking ? 'map-hud-track-on' : ''}`}
            onClick={() => setTracking((v) => !v)}
            disabled={!hasFix}
            title={hasFix ? 'Camera follows the rocket' : 'Waiting for GPS fix'}
          >
            {tracking ? '● Tracking' : 'Track'}
          </button>
        </div>
      </div>
    </div>
  );
}
