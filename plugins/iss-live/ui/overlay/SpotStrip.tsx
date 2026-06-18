// Bottom telemetry strip, ported from the legacy OverlayController spot-row.
// Two layouts:
//   Two-stage (default): [booster ALT|VEL|tilt] | timer | [sustainer tilt|ALT|VEL]
//   Single-stage:        [ALT|VEL] | timer | [tilt|ACCEL|MACH]
// A radial-dim .spot-overlay layer fades with the row via OverlayVisibility.spot.
// Telemetry from gss-bridge Tlm subjects per midas target.
//
// Domain rules carried from legacy:
//   - m -> ft at the display layer
//   - KF-velocity railed above 6500 ft/s, shown as 0 with (F) suffix
//   - GPS altitude crossover at 80kft when sat lock exists
//   - Mach via standard-atmosphere on booster baro alt
//   - FSM_State drives the timer label transitions

import { useMemo } from 'preact/hooks';
import standardAtmosphere from 'standard-atmosphere';
import { subjects, useStream } from '@its/sdk-react';
import { useOverlayVisibility } from './globals';
import { CountdownTimer } from './CountdownTimer';
import { BoosterSVG, SustainerSVG } from './OverlayVis';

const M_TO_FT = 3.28084;
const KF_RAIL_FT_PER_S = 6500;
const GPS_CROSSOVER_FT = 80_000;

// Default target keys when the active format doesn't pin them.
const DEFAULT_BOOSTER_TARGET = 'm007';
const DEFAULT_SUSTAINER_TARGET = 'm008';

interface Props {
  boosterTarget?: string;
  sustainerTarget?: string;
}

function fmtDigits(value: number, width: number): string {
  const cap = Number('9'.repeat(width));
  let abs = Math.round(Math.abs(value));
  if (abs > cap) abs = cap;
  const padded = abs.toString().padStart(width, '0');
  const out: string[] = [];
  for (let i = 0; i < padded.length; i++) {
    if (i > 0 && (padded.length - i) % 3 === 0) out.push(' ');
    out.push(padded[i]);
  }
  return `${value < 0 ? '-' : ' '}${out.join('')}`;
}

export function SpotStrip({ boosterTarget, sustainerTarget }: Props) {
  const vis = useOverlayVisibility();
  const booster = useStream(subjects.gssBridge.tlm(boosterTarget ?? DEFAULT_BOOSTER_TARGET));
  const sustainer = useStream(subjects.gssBridge.tlm(sustainerTarget ?? DEFAULT_SUSTAINER_TARGET));

  const b = booster.value;
  const s = sustainer.value;
  const hasBooster = !!b;
  const hasSustainer = !!s;

  const boosterVelFt = (b?.kf_velocity ?? 0) * M_TO_FT;
  const sustainerVelFt = (s?.kf_velocity ?? 0) * M_TO_FT;
  const boosterRailed = Math.abs(boosterVelFt) > KF_RAIL_FT_PER_S;
  const sustainerRailed = Math.abs(sustainerVelFt) > KF_RAIL_FT_PER_S;
  const boosterVelDisplay = boosterRailed ? 0 : boosterVelFt;
  const sustainerVelDisplay = sustainerRailed ? 0 : sustainerVelFt;

  const sustainerBaroFt = (s?.barometer_altitude ?? 0) * M_TO_FT;
  const sustainerGpsFt = (s?.altitude ?? 0) * M_TO_FT;
  const sustainerHasGpsLock = (s?.sat_count ?? 0) > 0;
  let sustainerAltFt = sustainerBaroFt;
  let sustainerAltQty = '';
  let sustainerAltClass = '';
  if (sustainerHasGpsLock && (sustainerGpsFt > GPS_CROSSOVER_FT || sustainerBaroFt > GPS_CROSSOVER_FT)) {
    sustainerAltFt = sustainerGpsFt;
    sustainerAltQty = '(GPS)';
  } else if (!sustainerHasGpsLock && sustainerBaroFt > GPS_CROSSOVER_FT) {
    sustainerAltClass = 'alt-text-no-gps-lock';
    sustainerAltQty = '(B)';
  }

  const { mach, accelG } = useMemo(() => {
    if (!b) return { mach: 0, accelG: 0 };
    const baroAlt = b.barometer_altitude > 0 ? b.barometer_altitude : 0;
    const { ssound } = standardAtmosphere(baroAlt, { si: true });
    const m = ssound > 0 ? Math.abs(b.kf_velocity) / ssound : 0;
    const a = Math.sqrt(b.highG_ax ** 2 + b.highG_ay ** 2 + b.highG_az ** 2);
    return { mach: m, accelG: a };
  }, [b?.barometer_altitude, b?.kf_velocity, b?.highG_ax, b?.highG_ay, b?.highG_az]);

  const fsm = b?.FSM_State ?? -1;
  const hasLaunched = fsm > 2;
  const labelText = hasLaunched
    ? `FSM ${fsm}`
    : fsm > 1 ? 'AWAITING LAUNCH' : 'AWAITING ARMING';
  const timerText = hasLaunched
    ? 'TIMER'
    : fsm > 1 ? 'ARMED' : 'STANDBY';
  const showT = vis.t_clock || hasLaunched;

  const visible = vis.spot;
  const rowFade = visible ? 'overlay-row-in' : 'overlay-row-out';
  const spotFade = visible ? 'spot-overlay-in' : 'spot-overlay-out';

  const boosterTilt = b?.tilt_angle ?? 0;
  const sustainerTilt = s?.tilt_angle ?? 0;

  const TimerBlock = (
    <div className="overlay-row-element">
      <div className="overlay-spot-timer-above-label">{labelText}</div>
      <div className="overlay-spot-timer-main">
        {showT ? <>T<CountdownTimer digitMode={3} /></> : timerText}
      </div>
    </div>
  );

  return (
    <>
      <div className={`spot-overlay start-hidden ${spotFade}`} />
      <div className={`overlay-position-bottom start-hidden ${rowFade}`}>
        {vis.single_stage_mode
          ? (
            <div className="overlay-row">
              <div className={`overlay-row-group ${hasBooster ? '' : 'overlay-row-group-disabled'}`}>
                <ValueBlock label="ALTITUDE" qty="BAROMETRIC" main={fmtDigits((b?.barometer_altitude ?? 0) * M_TO_FT, 6)} unit="FT" />
                <ValueBlock label="VELOCITY" qty={boosterRailed ? '(F)' : 'KALMAN'} main={fmtDigits(boosterVelDisplay, 4)} unit="FT/S" />
              </div>
              {TimerBlock}
              <div className={`overlay-row-group ${hasBooster ? '' : 'overlay-row-group-disabled'}`}>
                <TiltBlock kind="booster" visible={visible} hasTelem={hasBooster} angle={boosterTilt} />
                <ValueBlock label="ACCEL" qty="FORCE" main={accelG.toFixed(1)} unit="G" />
                <ValueBlock label="MACH" qty="NUMBER" main={mach.toFixed(2)} />
              </div>
            </div>
          )
          : (
            <div className="overlay-row">
              <div className={`overlay-row-group ${hasBooster ? '' : 'overlay-row-group-disabled'}`}>
                <ValueBlock label="BOOSTER" qty="ALTITUDE" main={fmtDigits((b?.barometer_altitude ?? 0) * M_TO_FT, 6)} unit="FT" />
                <ValueBlock label="BOOSTER" qty={`VELOCITY ${boosterRailed ? '(F)' : ''}`} main={fmtDigits(boosterVelDisplay, 4)} unit="FT/S" />
                <TiltBlock kind="booster" visible={visible} hasTelem={hasBooster} angle={boosterTilt} />
              </div>
              {TimerBlock}
              <div className={`overlay-row-group ${hasSustainer ? '' : 'overlay-row-group-disabled'}`}>
                <TiltBlock kind="sustainer" visible={visible} hasTelem={hasSustainer} angle={sustainerTilt} />
                <ValueBlock label="SUSTAINER" qty={`ALTITUDE ${sustainerAltQty}`} main={fmtDigits(sustainerAltFt, 6)} unit="FT" mainClass={sustainerAltClass} />
                <ValueBlock label="SUSTAINER" qty={`VELOCITY ${sustainerRailed ? '(F)' : ''}`} main={fmtDigits(sustainerVelDisplay, 4)} unit="FT/S" />
              </div>
            </div>
          )
        }
      </div>
    </>
  );
}

function ValueBlock({
  label,
  qty,
  main,
  unit,
  mainClass,
}: {
  label: string;
  qty: string;
  main: string;
  unit?: string;
  mainClass?: string;
}) {
  return (
    <div className="overlay-row-telem-group">
      <div className="overlay-v-align">
        <div className="overlay-row-telem-title">
          <div className="overlay-row-telem-title-name">{label}</div>
          <div className="overlay-row-telem-title-qty">{qty}</div>
        </div>
      </div>
      <div className="overlay-v-align">
        <div className={`overlay-row-telem-main ${mainClass ?? ''}`}>{main}</div>
      </div>
      {unit && (
        <div className="overlay-v-align">
          <div className="overlay-row-telem-unit">{unit}</div>
        </div>
      )}
    </div>
  );
}

function TiltBlock({
  kind,
  visible,
  hasTelem,
  angle,
}: {
  kind: 'booster' | 'sustainer';
  visible: boolean;
  hasTelem: boolean;
  angle: number;
}) {
  return (
    <div className="overlay-row-telem-group">
      <div className="overlay-v-align">
        <div className="overlay-tilt-wrapper">
          <div className={`overlay-tilt-hind ${visible ? 'tilt-hind-in' : 'tilt-hind-out'}`} />
          <div className={`overlay-tilt-vind ${visible ? 'tilt-vind-in' : 'tilt-vind-out'}`} />
          {kind === 'booster'
            ? <BoosterSVG visible={visible && hasTelem} angle={angle} hasTelem={hasTelem} />
            : <SustainerSVG visible={visible && hasTelem} angle={angle} hasTelem={hasTelem} />
          }
        </div>
      </div>
    </div>
  );
}
