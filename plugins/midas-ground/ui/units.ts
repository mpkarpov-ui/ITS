// Unit conversion + formatting for midas-ground readouts. Telemetry arrives in
// canonical SI (m, m/s, m/s², °C, kPa); useUnits() returns reactive formatters
// so a settings change re-paints every card and chart on the next render.

import { useMemo } from 'preact/hooks';
import { useSetting } from '@its/sdk-react';

export type UnitSystem = 'metric' | 'imperial';
type AccelOverride = 'auto' | 'g';
type TempOverride = 'auto' | 'c' | 'f' | 'k';
type PressureOverride = 'auto' | 'kpa' | 'psi' | 'bar' | 'atm';
type AltitudeOverride = 'auto' | 'm' | 'ft' | 'km' | 'mi';
type VelocityOverride = 'auto' | 'mps' | 'fps' | 'kmh' | 'mph' | 'kn';

export interface UnitFormatter {
  /** Display unit string (e.g. "m", "ft", "°F"). */
  unit: string;
  /** Convert canonical SI -> display unit. */
  convert(siValue: number): number;
  /** Format a (possibly missing) SI value to a fixed-digit display string. Returns "—" for undefined/null/NaN. */
  format(siValue: number | undefined | null, digits?: number): string;
}

export interface Units {
  altitude: UnitFormatter;
  velocity: UnitFormatter;
  acceleration: UnitFormatter;
  temperature: UnitFormatter;
  pressure: UnitFormatter;
}

// Conversion constants. Canonical SI on the left.
const G_M_S2 = 9.80665;
const M_TO_FT = 3.28084;
const M_TO_MI = 0.000621371;
const M_PER_S_TO_KM_H = 3.6;
const M_PER_S_TO_MPH = 2.23694;
const M_PER_S_TO_KN = 1.94384;
const KPA_TO_PSI = 0.145038;
const KPA_TO_BAR = 0.01;
const KPA_TO_ATM = 0.00986923;

function makeFormatter(unit: string, scale: number, offset = 0): UnitFormatter {
  return {
    unit,
    convert: (v) => v * scale + offset,
    format: (v, digits = 2) =>
      v === undefined || v === null || Number.isNaN(v)
        ? '—'
        : (v * scale + offset).toFixed(digits),
  };
}

export function useUnits(): Units {
  const [system] = useSetting<UnitSystem>(
    'midas-ground',
    'unitSystem',
    'metric',
  );
  const [accelOv] = useSetting<AccelOverride>(
    'midas-ground',
    'accelerationUnit',
    'auto',
  );
  const [tempOv] = useSetting<TempOverride>(
    'midas-ground',
    'temperatureUnit',
    'auto',
  );
  const [pressOv] = useSetting<PressureOverride>(
    'midas-ground',
    'pressureUnit',
    'auto',
  );
  const [altOv] = useSetting<AltitudeOverride>(
    'midas-ground',
    'altitudeUnit',
    'auto',
  );
  const [velOv] = useSetting<VelocityOverride>(
    'midas-ground',
    'velocityUnit',
    'auto',
  );

  return useMemo<Units>(() => {
    const imperial = system === 'imperial';

    const altEff: Exclude<AltitudeOverride, 'auto'> =
      altOv === 'auto' ? (imperial ? 'ft' : 'm') : altOv;
    const altitude =
      altEff === 'ft'
        ? makeFormatter('ft', M_TO_FT)
        : altEff === 'km'
          ? makeFormatter('km', 0.001)
          : altEff === 'mi'
            ? makeFormatter('mi', M_TO_MI)
            : makeFormatter('m', 1);

    const velEff: Exclude<VelocityOverride, 'auto'> =
      velOv === 'auto' ? (imperial ? 'fps' : 'mps') : velOv;
    const velocity =
      velEff === 'fps'
        ? makeFormatter('ft/s', M_TO_FT)
        : velEff === 'kmh'
          ? makeFormatter('km/h', M_PER_S_TO_KM_H)
          : velEff === 'mph'
            ? makeFormatter('mph', M_PER_S_TO_MPH)
            : velEff === 'kn'
              ? makeFormatter('kn', M_PER_S_TO_KN)
              : makeFormatter('m/s', 1);

    // Acceleration: explicit g override beats the unit system (peak g matters
    // regardless of metric/imperial). Otherwise imperial -> ft/s², metric -> m/s².
    const acceleration =
      accelOv === 'g'
        ? makeFormatter('g', 1 / G_M_S2)
        : imperial
          ? makeFormatter('ft/s²', M_TO_FT)
          : makeFormatter('m/s²', 1);

    const tempEff: Exclude<TempOverride, 'auto'> =
      tempOv === 'auto' ? (imperial ? 'f' : 'c') : tempOv;
    const temperature =
      tempEff === 'f'
        ? makeFormatter('°F', 9 / 5, 32)
        : tempEff === 'k'
          ? makeFormatter('K', 1, 273.15)
          : makeFormatter('°C', 1);

    const pressEff: Exclude<PressureOverride, 'auto'> =
      pressOv === 'auto' ? (imperial ? 'psi' : 'kpa') : pressOv;
    const pressure =
      pressEff === 'psi'
        ? makeFormatter('psi', KPA_TO_PSI)
        : pressEff === 'bar'
          ? makeFormatter('bar', KPA_TO_BAR)
          : pressEff === 'atm'
            ? makeFormatter('atm', KPA_TO_ATM)
            : makeFormatter('kPa', 1);

    return { altitude, velocity, acceleration, temperature, pressure };
  }, [system, accelOv, tempOv, pressOv, altOv, velOv]);
}
