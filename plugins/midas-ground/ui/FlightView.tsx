import { useEffect, useMemo, useRef } from 'preact/hooks';
import standardAtmosphere from 'standard-atmosphere';

import { useHistory } from '@its/sdk-react';
import { useMidasTlm } from './hooks';
import { useUnits } from './units';
import { Graph } from './components/Graph';
import { MidasNav } from './components/MidasNav';
import {
  MultiValue,
  SingleValue,
  ValueGroup,
} from './components/ValueDisplay';
import {
  STATE_BURNOUT,
  STATE_PYRO_TEST,
  STATE_SAFE,
  bits2ToTF,
  camColor,
  camLabel,
  fixName,
  stateName,
} from './components/midas';
import './FlightView.css';

// Direct port of GSS FullTelemetryView: graphs + cameras left, value cards
// right. Renders the full layout even when the stream is silent (fields show
// "—"); real launch telemetry has gaps and the dashboard shouldn't look broken.
// LIVE/STALE pill lives in MidasNav, one per page.

const NUM = (v: number | undefined, digits = 2): string =>
  v === undefined || v === null || Number.isNaN(v) ? '—' : v.toFixed(digits);
const INT = (v: number | undefined): string =>
  v === undefined || v === null ? '—' : String(v);

// Aerodynamic derivation constants. Computed in SI; useUnits converts at display.
const GAMMA_AIR = 1.4;
const STAG_TEMP_COEFF = (GAMMA_AIR - 1) / 2;
// Tlm is ~10Hz. useHistory exposes no per-sample timestamps, so the
// descent-velocity regression assumes a uniform interval; cadence drift scales
// the slope by the same factor.
const ASSUMED_DT_S = 0.1;

export function FlightView() {
  const { value: t, subject } = useMidasTlm();
  // Last 30 samples (~3s at 10Hz) for descent-velocity regression.
  const history = useHistory(subject, 30);
  const u = useUnits();

  const accelMag = t
    ? Math.sqrt(t.highG_ax ** 2 + t.highG_ay ** 2 + t.highG_az ** 2)
    : undefined;

  // Atmospheric properties at current barometer altitude. Return zeros below
  // sea level / empty rather than feeding the model garbage.
  const baroAlt = t?.barometer_altitude ?? 0;
  const velocity = t?.kf_velocity ?? 0;
  const { mach, dynamicPressureKPa, stagTempC } = useMemo(() => {
    if (baroAlt <= 0) {
      return { mach: 0, dynamicPressureKPa: 0, stagTempC: 0 };
    }
    const { density, ssound, temperature } = standardAtmosphere(baroAlt, {
      si: true,
    });
    const m = ssound > 0 ? velocity / ssound : 0;
    // Pa -> kPa for the canonical pressure unit.
    const q_kpa = (0.5 * density * velocity * velocity) / 1000;
    const stag = temperature * (1 + m * m * STAG_TEMP_COEFF) - 273.15;
    return { mach: m, dynamicPressureKPa: q_kpa, stagTempC: stag };
  }, [baroAlt, velocity]);

  // Descent velocity (m/s): slope of barometric altitude over recent history.
  // Positive = climbing. Independent sanity-check against KF velocity.
  const descentVel = useMemo(() => {
    if (history.length < 5) return undefined;
    const ys = history.map((h) => h.barometer_altitude);
    const n = ys.length;
    let sx = 0;
    let sy = 0;
    let sxy = 0;
    let sx2 = 0;
    for (let i = 0; i < n; i++) {
      const x = i * ASSUMED_DT_S;
      sx += x;
      sy += ys[i];
      sxy += x * ys[i];
      sx2 += x * x;
    }
    const denom = n * sx2 - sx * sx;
    if (denom === 0) return undefined;
    return (n * sxy - sx * sy) / denom;
  }, [history]);

  // Snapshot tilt on the FSM transition into BURNOUT; it sticks through
  // coast/apogee/descent for post-flight review. Cleared on re-arm (SAFE/PYRO_TEST).
  const tiltAtBurnoutRef = useRef<number | null>(null);
  const prevStateRef = useRef<number | null>(null);
  useEffect(() => {
    if (!t) return;
    const prev = prevStateRef.current;
    if (t.FSM_State === STATE_BURNOUT && prev !== STATE_BURNOUT) {
      tiltAtBurnoutRef.current = t.tilt_angle;
    }
    if (t.FSM_State === STATE_SAFE || t.FSM_State === STATE_PYRO_TEST) {
      tiltAtBurnoutRef.current = null;
    }
    prevStateRef.current = t.FSM_State;
  }, [t?.FSM_State, t?.tilt_angle]);
  const tiltAtBurnout = tiltAtBurnoutRef.current;

  // c_valid==0 means the cam fields are trustworthy; otherwise the Cameras
  // card hides behind a NO VALID CAM DATA overlay.
  const camValid = t ? t.c_valid === 0 : false;
  const camsOnBits = t?.c_on ?? 0;
  const camsRecBits = t?.c_rec ?? 0;
  const [cam1On, cam2On] = bits2ToTF(camsOnBits);
  const [cam1Rec, cam2Rec] = bits2ToTF(camsRecBits);
  const vtxOn = (t?.vtx_on ?? 0) === 1;
  const vmuxState = t?.vmux_stat ?? 0;
  const camAck = t?.cam_ack ?? 0;
  const camBattVolt = t?.cam_battery_voltage ?? 0;

  // X/Y/Z reuse error/live/accent tokens for red/green/blue so the axis colors
  // re-theme with the palette (not actually status indicators).
  const axisColors = [
    'var(--status-error)',
    'var(--status-live)',
    'var(--accent)',
  ];

  return (
    <div class="midas-page">
      <MidasNav />
      <div class="flight-view">
        <div class="flight-view-left">
          <ValueGroup label="Telemetry Graphs">
            <div class="graph-row">
              <Graph
                subject={subject}
                channels={[{ field: 'barometer_altitude', label: 'Altitude (B)', color: '#d97400' }]}
                yLabel="Barometer Altitude"
                unitFormatter={u.altitude}
              />
              <Graph
                subject={subject}
                channels={[
                  { field: 'highG_ax', label: 'X', color: '#cc0000' },
                  { field: 'highG_ay', label: 'Y', color: '#00cc00' },
                  { field: 'highG_az', label: 'Z', color: '#3366ff' },
                ]}
                yLabel="Acceleration"
                unitFormatter={u.acceleration}
              />
              <Graph
                subject={subject}
                channels={[{ field: 'RSSI', label: 'RSSI', color: '#d97400' }]}
                yLabel="Signal Strength"
                unit="dBm"
              />
            </div>
            <div class="graph-row">
              <Graph
                subject={subject}
                channels={[{ field: 'tilt_angle', label: 'Tilt Angle', color: '#d97400' }]}
                yLabel="Angle"
                unit="deg"
              />
              <Graph
                subject={subject}
                channels={[{ field: 'kf_velocity', label: 'Velocity', color: '#d97400' }]}
                yLabel="Velocity"
                unitFormatter={u.velocity}
              />
              <Graph
                subject={subject}
                channels={[{ field: 'battery_voltage', label: 'Battery Voltage', color: '#d97400' }]}
                yLabel="Voltage"
                unit="V"
              />
            </div>
          </ValueGroup>

          <ValueGroup
            label="Cameras"
            hidden={!camValid}
            hiddenLabelText="NO VALID CAM DATA"
          >
            <MultiValue
              label="Camera State"
              titles={['CAM 1', 'CAM 2', 'IMG PHASE', 'FRAME PARITY', 'CAM ACK', 'VBATT', 'RAW']}
              values={[
                camLabel(cam1On, cam1Rec),
                camLabel(cam2On, cam2Rec),
                vtxOn ? 'LOCKED' : 'NOLOCK',
                vmuxState === 0 ? 'EVEN' : 'ODD',
                INT(camAck),
                NUM(camBattVolt, 2),
                `${camsOnBits} ${camsRecBits} ${vtxOn ? 'T' : 'F'} ${vmuxState ? 'C2' : 'C1'} ${camAck}`,
              ]}
              dataColors={[
                camColor(cam1On, cam1Rec),
                camColor(cam2On, cam2Rec),
                vtxOn ? 'var(--status-live)' : 'var(--status-error)',
                'var(--text)',
                'var(--text)',
                'var(--text)',
                'var(--text-dim)',
              ]}
              units={['', '', '', '', '', 'V', '']}
            />
          </ValueGroup>
        </div>

        <div class="flight-view-right">
          <ValueGroup label="Telemetry Data" smallLabels>
            <SingleValue
              label="Stage State"
              value={t === null ? '—' : stateName(t.FSM_State)}
            />
            <MultiValue
              label="Gyroscopic"
              titles={['Tilt', 'Tilt @ Burnout', 'Roll Rate']}
              values={[
                NUM(t?.tilt_angle, 1),
                tiltAtBurnout === null ? '—' : tiltAtBurnout.toFixed(1),
                NUM(t?.roll_rate, 2),
              ]}
              units={['°', '°', 'rot/s']}
            />
            <MultiValue
              label="Dynamics"
              titles={['Altitude (Baro)', 'Descent Vel (DRV)', 'Accel |a|']}
              values={[
                u.altitude.format(t?.barometer_altitude, 1),
                u.velocity.format(descentVel, 1),
                u.acceleration.format(accelMag, 2),
              ]}
              units={[u.altitude.unit, u.velocity.unit, u.acceleration.unit]}
            />
            <MultiValue
              label=""
              titles={['Mach', 'Dyn Pressure', 'Stag Temp']}
              values={[
                NUM(mach, 2),
                u.pressure.format(dynamicPressureKPa, 2),
                u.temperature.format(stagTempC, 0),
              ]}
              units={['', u.pressure.unit, u.temperature.unit]}
            />
            <MultiValue
              label="Acceleration"
              titles={['X', 'Y', 'Z']}
              values={[
                u.acceleration.format(t?.highG_ax),
                u.acceleration.format(t?.highG_ay),
                u.acceleration.format(t?.highG_az),
              ]}
              labelColors={axisColors}
              units={[u.acceleration.unit, u.acceleration.unit, u.acceleration.unit]}
            />
            <MultiValue
              label="Comms"
              titles={['RSSI', 'Frequency', 'Sustainer']}
              values={[NUM(t?.RSSI, 0), NUM(t?.frequency, 2), INT(t?.is_sustainer)]}
              units={['dBm', 'MHz', '']}
            />
            <MultiValue
              label="Pyro Continuity"
              titles={['A', 'B', 'C', 'D']}
              values={[NUM(t?.pyro_a), NUM(t?.pyro_b), NUM(t?.pyro_c), NUM(t?.pyro_d)]}
              units={['V', 'V', 'V', 'V']}
            />
            <MultiValue
              label="Tracking"
              titles={['LAT', 'LONG', 'ALT (GPS)']}
              values={[
                NUM(t?.latitude, 6),
                NUM(t?.longitude, 6),
                u.altitude.format(t?.altitude, 1),
              ]}
              units={['°', '°', u.altitude.unit]}
            />
            <MultiValue
              label=""
              titles={['GNSS Fix Type', 'SIV', 'KF VelX']}
              values={[
                t === null ? '—' : fixName(t.gps_fixtype),
                INT(t?.sat_count),
                u.velocity.format(t?.kf_velocity, 2),
              ]}
              units={['', '', u.velocity.unit]}
            />
            <MultiValue
              label="KF Position"
              titles={['X', 'Y', 'Z']}
              values={[
                u.altitude.format(t?.kf_positionX),
                u.altitude.format(t?.kf_positionY),
                u.altitude.format(t?.kf_positionZ),
              ]}
              labelColors={axisColors}
              units={[u.altitude.unit, u.altitude.unit, u.altitude.unit]}
            />
          </ValueGroup>
        </div>
      </div>
    </div>
  );
}
