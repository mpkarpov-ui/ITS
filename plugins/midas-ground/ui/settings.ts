// Settings schema for midas-ground. Kept separate from ui/index.tsx so
// /settings can lazy-load just this module without the main bundle. Covers
// telemetry retention (read by the WS-bridge) and display units (read by
// useUnits in ui/units.ts).

import { defineSettings } from '@its/sdk-react';

export const settings = defineSettings({
  telemetryRetention: {
    type: 'enum',
    label: 'Telemetry retention on reload',
    default: '100',
    options: [
      { value: '0', label: 'OFF - discard on refresh' },
      { value: '100', label: 'Last 100' },
      { value: '500', label: 'Last 500' },
      { value: '1000', label: 'Last 1000' },
      { value: '-1', label: 'Unlimited (until max)' },
    ],
    hint: 'How many recent samples per subject to restore after a page reload. Affects all graphs / trails.',
  },
  unitSystem: {
    type: 'enum',
    label: 'Unit system',
    default: 'metric',
    options: [
      { value: 'metric', label: 'Metric (m, m/s, m/s², °C, kPa)' },
      { value: 'imperial', label: 'Imperial (ft, ft/s, ft/s², °F, psi)' },
    ],
    hint: 'Master switch for displayed units. The per-quantity overrides below take precedence when set.',
  },
  accelerationUnit: {
    type: 'enum',
    label: 'Acceleration unit',
    default: 'auto',
    options: [
      { value: 'auto', label: 'Auto (follow unit system)' },
      { value: 'g', label: 'g (×9.80665 m/s²)' },
    ],
    hint: 'g-force is independent of metric/imperial; pick it explicitly if you want every acceleration readout in g regardless of the system above.',
  },
  temperatureUnit: {
    type: 'enum',
    label: 'Temperature unit',
    default: 'auto',
    options: [
      { value: 'auto', label: 'Auto (°C metric, °F imperial)' },
      { value: 'c', label: 'Celsius (°C)' },
      { value: 'f', label: 'Fahrenheit (°F)' },
      { value: 'k', label: 'Kelvin (K)' },
    ],
  },
  pressureUnit: {
    type: 'enum',
    label: 'Pressure unit',
    default: 'auto',
    options: [
      { value: 'auto', label: 'Auto (kPa metric, psi imperial)' },
      { value: 'kpa', label: 'kPa' },
      { value: 'psi', label: 'psi' },
      { value: 'bar', label: 'bar' },
      { value: 'atm', label: 'atm' },
    ],
    hint: 'Pressure has many conventional units across communities; pick whichever your team reads fastest.',
  },
  altitudeUnit: {
    type: 'enum',
    label: 'Altitude unit',
    default: 'auto',
    options: [
      { value: 'auto', label: 'Auto (m metric, ft imperial)' },
      { value: 'm', label: 'metres' },
      { value: 'ft', label: 'feet' },
      { value: 'km', label: 'kilometres' },
      { value: 'mi', label: 'miles' },
    ],
    hint: 'Override applies to barometer altitude, GPS altitude, and KF Position cards.',
  },
  velocityUnit: {
    type: 'enum',
    label: 'Velocity unit',
    default: 'auto',
    options: [
      { value: 'auto', label: 'Auto (m/s metric, ft/s imperial)' },
      { value: 'mps', label: 'm/s' },
      { value: 'fps', label: 'ft/s' },
      { value: 'kmh', label: 'km/h' },
      { value: 'mph', label: 'mph' },
      { value: 'kn', label: 'knots' },
    ],
  },
} as const);
