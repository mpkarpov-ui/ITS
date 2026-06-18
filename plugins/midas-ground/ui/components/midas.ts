// MIDAS FSM + GPS fix-type decoders + camera-state helpers. Lifted from GSS's
// midasconversion.jsx to keep state names and camera color semantics identical.

const MIDAS_STATES = [
  'STATE_SAFE',
  'STATE_PYRO_TEST',
  'STATE_IDLE',
  'STATE_FIRST_BOOST',
  'STATE_BURNOUT',
  'STATE_COAST',
  'STATE_APOGEE',
  'STATE_DROGUE_DEPLOY',
  'STATE_DROGUE',
  'STATE_MAIN_DEPLOY',
  'STATE_MAIN',
  'STATE_LANDED',
  'STATE_SUSTAINER_IGNITION',
  'STATE_SECOND_BOOST',
  'STATE_FIRST_SEPARATION',
];

const GPS_FIX_TYPES = ['NOFIX', 'DRECK', 'GPS2D', 'GPS3D', 'G3DDR'];

// State indices that need to be referenced from code (e.g. burnout-capture,
// safing rearms). Match MIDAS_STATES order above.
export const STATE_SAFE = 0;
export const STATE_PYRO_TEST = 1;
export const STATE_BURNOUT = 4;

export function stateName(state: number): string {
  if (state < 0) return 'NO_DATA';
  const raw = MIDAS_STATES[state];
  if (!raw) return 'ERR';
  return raw.replace('STATE_', '');
}

export function fixName(fix: number): string {
  if (fix < 0) return 'NODAT';
  return GPS_FIX_TYPES[fix] ?? 'INVAL';
}

// Two cameras packed into a 2-bit field: bit 1 = cam 1, bit 0 = cam 2.
// Decodes c_on (powered) and c_rec (recording).
export function bits2ToTF(value: number): [boolean, boolean] {
  const cam1 = (value & 0b10) !== 0;
  const cam2 = (value & 0b01) !== 0;
  return [cam1, cam2];
}

// Per-camera state -> display text + color token, matching GSS's REC/ON/OFF
// triage so it reads the same alongside old launch videos.
export function camLabel(on: boolean, rec: boolean): string {
  if (!on) return 'CAM OFF';
  return rec ? 'CAM REC' : 'CAM ON';
}

export function camColor(on: boolean, rec: boolean): string {
  if (!on) return 'var(--status-error)';
  return rec ? 'var(--status-live)' : 'var(--status-stale)';
}
