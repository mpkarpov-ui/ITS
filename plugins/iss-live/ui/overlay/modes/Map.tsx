// Broadcast map overlay: a Cesium Columbus-View (2.5D) globe with an orbiting
// camera, per-stage position markers, altitude trails, and pulse rings. Ported
// from the legacy GSS StreamMapOverlay (LivePlotter overlay branch). Every knob
// is a URL query param on the OBS browser source, with the same names/defaults
// as legacy:
//   /overlay?mode=map&track=b|s&orbitspeed=&pitch=&distance=&adaptive=1
//            &usekf=1&labelname=&labelcolor=
// Stage targets and the camera-home launch site come from the active format, so
// the plugin stays mission-agnostic. Cesium setup mirrors midas-ground/MapView
// (Esri satellite imagery, flat ellipsoid, optional Ion world terrain). Default
// export so the overlay can lazy() this whole module (cesium is ~3MB and must
// not land in the default-overlay chunk).

import { useEffect, useMemo, useRef } from 'preact/hooks';
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
  HeadingPitchRange,
  BoundingSphere,
  CallbackProperty,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { subjects, useStream } from '@its/sdk-react';

// Matches SpotStrip so the map and the telemetry strip read the same vehicles.
const DEFAULT_BOOSTER_TARGET = 'm007';
const DEFAULT_SUSTAINER_TARGET = 'm008';

const TRAIL_UPDATE_MS = 100; // trail breadcrumb sampling (~10Hz)
const PULSE_CYCLE_MS = 2500; // pulse-ring animation period
const TO_RAD = Math.PI / 180;

// Fixed two-stage config (legacy STAGE_CHANNELS). Colors are constants; the
// tracked stage's label/color can be overridden via ?labelname / ?labelcolor.
const STAGE_DEFS = [
  { name: 'Booster', color: () => Color.FIREBRICK },
  { name: 'Sustainer', color: () => Color.DODGERBLUE },
];

export interface LaunchSite {
  lat: number;
  lon: number;
}

interface Props {
  search: string; // overlay query string (knobs ride here)
  boosterTarget: string;
  sustainerTarget?: string;
  launchSite: LaunchSite;
}

interface Knobs {
  trackIndex: number | null;
  orbitSpeed: number;
  pitch: number;
  distance: number;
  adaptive: boolean;
  useKF: boolean;
  labelOverrides: Record<number, { name?: string; color?: string }>;
}

interface StageState {
  latest: { lat: number; lon: number; alt: number; fsm: number } | null;
  normAlt: number | null;
  fired: boolean;
  lastTrailUpdate: number;
  trailPositions: Cartesian3[];
  pointEntity: any;
  trailLine: any;
  pulseEntity: any;
  lastGpsLat: number | null;
  lastGpsLon: number | null;
  kfTailStart: number;
}

function createDiscTexture(cssColor: string): HTMLCanvasElement {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 2, 0, 2 * Math.PI);
  ctx.fillStyle = cssColor;
  ctx.fill();
  return canvas;
}

// Parse the OBS-source query string into knobs. Defaults and the `|| default`
// idiom (so e.g. pitch=0 falls back to -45) are preserved verbatim from legacy.
function parseKnobs(search: string): Knobs {
  const params = new URLSearchParams(search);
  const track = params.get('track');
  const trackIndex = track === 'b' ? 0 : track === 's' ? 1 : null;
  const orbitSpeed = parseFloat(params.get('orbitspeed') ?? '') || 0.0006;
  const pitch = parseFloat(params.get('pitch') ?? '') || -45;
  const distance = parseFloat(params.get('distance') ?? '') || 10000;
  const adaptive = params.get('adaptive') === '1';
  const useKF = params.get('usekf') === '1';

  const labelOverrides: Record<number, { name?: string; color?: string }> = {};
  const labelName = params.get('labelname');
  const labelColor = params.get('labelcolor');
  if (trackIndex != null && (labelName || labelColor)) {
    labelOverrides[trackIndex] = {};
    if (labelName) labelOverrides[trackIndex].name = labelName;
    if (labelColor) {
      labelOverrides[trackIndex].color = labelColor.startsWith('#') ? labelColor : `#${labelColor}`;
    }
  }
  return { trackIndex, orbitSpeed, pitch, distance, adaptive, useKF, labelOverrides };
}

function freshStage(): StageState {
  return {
    latest: null,
    normAlt: null,
    fired: false,
    lastTrailUpdate: 0,
    trailPositions: [],
    pointEntity: null,
    trailLine: null,
    pulseEntity: null,
    lastGpsLat: null,
    lastGpsLon: null,
    kfTailStart: 0,
  };
}

export default function MapScreen({ search, boosterTarget, sustainerTarget, launchSite }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const stagesRef = useRef<StageState[]>([freshStage(), freshStage()]);

  const knobs = useMemo(() => parseKnobs(search), [search]);

  // Live telemetry for both stages. The Cesium update is imperative, driven off
  // these values; identical subjects to SpotStrip so they share the cache.
  const booster = useStream(subjects.gssBridge.tlm(boosterTarget ?? DEFAULT_BOOSTER_TARGET));
  const sustainer = useStream(subjects.gssBridge.tlm(sustainerTarget ?? DEFAULT_SUSTAINER_TARGET));

  // Cesium viewer + entities: built once. Query knobs and launch site don't
  // change without a browser-source reload, so reading them at mount matches
  // legacy and keeps the orbit loop from rebuilding the scene.
  useEffect(() => {
    if (!containerRef.current) return;

    const { trackIndex, orbitSpeed, pitch, distance, adaptive, labelOverrides } = knobs;

    const ionToken = (import.meta as any).env?.VITE_CESIUM_ION_TOKEN as string | undefined;
    if (ionToken) Ion.defaultAccessToken = ionToken;

    let viewer: Viewer;
    try {
      const satellite = new UrlTemplateImageryProvider({
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        maximumLevel: 19,
      });
      // Detached div swallows Cesium's credit chrome (closed-LAN broadcast).
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
        terrainProvider: new EllipsoidTerrainProvider(),
      });
    } catch {
      return;
    }
    viewerRef.current = viewer;

    if (ionToken) {
      createWorldTerrainAsync()
        .then((terrain) => {
          if (viewer && !viewer.isDestroyed()) viewer.terrainProvider = terrain;
        })
        .catch(() => {
          /* keep flat ellipsoid if Ion terrain fails */
        });
    }

    viewer.resolutionScale = window.devicePixelRatio || 1;
    viewer.scene.mode = SceneMode.COLUMBUS_VIEW;

    viewer.camera.setView({
      destination: Cartesian3.fromDegrees(launchSite.lon, launchSite.lat, distance),
      orientation: { heading: 0, pitch: pitch * TO_RAD, roll: 0 },
    });

    const stages = stagesRef.current;
    STAGE_DEFS.forEach((cfg, index) => {
      const ovr = labelOverrides[index] || {};
      const labelName = ovr.name || cfg.name;
      const pointColor = ovr.color ? Color.fromCssColorString(ovr.color) : cfg.color();

      const pointEntity = viewer.entities.add({
        name: labelName,
        position: Cartesian3.fromDegrees(launchSite.lon, launchSite.lat, 0),
        point: { pixelSize: 10, color: pointColor },
        label: {
          text: labelName,
          font: '28px monospace',
          scale: 0.65,
          pixelOffset: new Cartesian2(0, -20),
          fillColor: Color.WHITE,
          outlineColor: Color.BLACK,
          outlineWidth: 4,
          style: LabelStyle.FILL_AND_OUTLINE,
        },
      });

      const trailCollection = viewer.scene.primitives.add(new PolylineCollection());
      const trailLine = trailCollection.add({
        positions: [],
        width: 2,
        material: Material.fromType('Color', { color: pointColor.withAlpha(0.85) }),
      });

      const discImage = createDiscTexture(pointColor.toCssColorString());
      const pulseEntity = viewer.entities.add({
        position: Cartesian3.fromDegrees(launchSite.lon, launchSite.lat, 0),
        billboard: {
          image: discImage,
          scale: new CallbackProperty(() => {
            const t = (Date.now() % PULSE_CYCLE_MS) / PULSE_CYCLE_MS;
            return 0.15 + t * 0.45;
          }, false),
          color: new CallbackProperty(() => {
            const t = (Date.now() % PULSE_CYCLE_MS) / PULSE_CYCLE_MS;
            return pointColor.withAlpha(0.5 * (1 - t));
          }, false),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          eyeOffset: new Cartesian3(0, 0, 1),
        },
      });

      stages[index].pointEntity = pointEntity;
      stages[index].trailLine = trailLine;
      stages[index].pulseEntity = pulseEntity;
    });

    // Auto-orbit the tracked stage; adaptive mode zooms by flight phase.
    let headingRad = 0;
    let currentDistance = distance;
    const pitchRad = pitch * TO_RAD;
    const orbitCallback = () => {
      if (viewer.isDestroyed()) return;
      headingRad += orbitSpeed;
      const idx = trackIndex;
      if (idx == null || !stages[idx] || !stages[idx].latest) return;
      const s = stages[idx];
      const displayAlt = (s.latest!.alt || 0) - (s.normAlt || 0);
      const target = Cartesian3.fromDegrees(s.latest!.lon, s.latest!.lat, displayAlt);

      let targetDistance = distance;
      if (adaptive) {
        const fsm = s.latest!.fsm;
        const pts = s.trailPositions;
        const bs = BoundingSphere.fromPoints(pts);
        if (fsm <= 2) {
          targetDistance = 1500; // before launch
        } else if (fsm <= 6) {
          targetDistance = pts.length >= 2 ? Math.max(bs.radius * 5, 1500) : 1500; // before apogee
        } else if (fsm <= 8) {
          targetDistance = Math.max(bs.radius * 3.5, 1500); // drogue
        } else if (fsm <= 10) {
          targetDistance = 1000;
        } else {
          targetDistance = 500; // landed
        }
      }
      currentDistance += (targetDistance - currentDistance) * 0.04;
      viewer.camera.lookAt(target, new HeadingPitchRange(headingRad, pitchRad, currentDistance));
    };
    viewer.scene.preRender.addEventListener(orbitCallback);

    return () => {
      const v = viewerRef.current;
      if (v && !v.isDestroyed()) v.destroy();
      viewerRef.current = null;
      stagesRef.current = [freshStage(), freshStage()];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Bind each telemetry packet to its stage marker + trail. NaN GPS skipped.
  // Altitude is normalized to launch level once the stage fires (FSM > 2). KF
  // altitude (kf_positionX) substitutes for GPS altitude before apogee when
  // ?usekf=1; on each confirmed GPS fix the provisional KF tail is reconciled.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const { useKF } = knobs;
    const channelData = [booster.value, sustainer.value];
    const stages = stagesRef.current;
    const now = Date.now();

    STAGE_DEFS.forEach((_cfg, index) => {
      const val = channelData[index];
      if (!val) return;

      const lat = Number(val.latitude);
      const lon = Number(val.longitude);
      if (isNaN(lat) || isNaN(lon)) return;
      const fsm = Number(val.FSM_State || 0);
      const kfAlt = Number(val.kf_positionX || 0);
      const kfActive = useKF && kfAlt !== 0 && fsm <= 6;
      const alt = kfActive ? kfAlt : Number(val.altitude || 0);

      const stage = stages[index];
      stage.latest = { lat, lon, alt, fsm };

      if (!stage.fired) {
        stage.normAlt = alt;
        if (fsm > 2) stage.fired = true;
      }

      const displayAlt = alt - (stage.normAlt || 0);
      const pos = Cartesian3.fromDegrees(lon, lat, displayAlt);
      stage.pointEntity.position = pos;
      if (stage.pulseEntity) stage.pulseEntity.position = pos;

      if (stage.fired && (now - stage.lastTrailUpdate > TRAIL_UPDATE_MS || stage.trailPositions.length === 0)) {
        stage.lastTrailUpdate = now;

        if (kfActive) {
          const gpsAlt = Number(val.altitude || 0) - (stage.normAlt || 0);
          const gpsChanged = stage.lastGpsLat !== null && (lat !== stage.lastGpsLat || lon !== stage.lastGpsLon);

          if (gpsChanged) {
            // New GPS fix: drop the provisional KF tail, commit a GPS point.
            stage.trailPositions.length = stage.kfTailStart;
            stage.trailPositions.push(Cartesian3.fromDegrees(lon, lat, gpsAlt));
            stage.kfTailStart = stage.trailPositions.length;
            stage.lastGpsLat = lat;
            stage.lastGpsLon = lon;
          } else if (stage.lastGpsLat === null) {
            stage.lastGpsLat = lat;
            stage.lastGpsLon = lon;
          }
          // Append a KF tail point: stale GPS lat/lon + live KF altitude.
          stage.trailPositions.push(Cartesian3.fromDegrees(lon, lat, displayAlt));
        } else {
          // GPS-only: flush any leftover KF tail first, then append.
          if (stage.kfTailStart < stage.trailPositions.length) {
            stage.trailPositions.length = stage.kfTailStart;
          }
          stage.trailPositions.push(pos);
          stage.kfTailStart = stage.trailPositions.length;
        }
        stage.trailLine.positions = stage.trailPositions.slice();
      }
    });
  }, [booster.value, sustainer.value, knobs]);

  return <div ref={containerRef} className="iss-map-overlay" />;
}
