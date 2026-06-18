// Top banner: T-clock + program name with an animated separator bar.
// Visibility from overlay_visibility.top_timer; HOLD chip shows when paused.

import { globals, useGlobal } from '@its/sdk-react';
import { useOverlayVisibility } from './globals';
import { CountdownTimer } from './CountdownTimer';

interface Props {
  programName: string;
  hasLaunched: boolean;
}

export function PassiveTimer({ programName, hasLaunched }: Props) {
  const vis = useOverlayVisibility();
  const [timer] = useGlobal(globals.midasGround.timer);

  const visible = vis.top_timer;
  const fadeClass = visible ? 'generic-fade-in' : 'generic-fade-out';
  const growClass = visible ? 'stream-passive-timer-sep-in' : 'stream-passive-timer-sep-out';

  const showT = vis.t_clock || hasLaunched;
  const timerPaused = timer?.paused ?? false;

  return (
    <div className="stream-passive-timer-wrapper">
      <div className="stream-passive-timer">
        <div className={`stream-passive-timer-main start-hidden ${fadeClass}`}>
          {showT
            ? <><span className="stream-passive-timer-m-text">T</span><CountdownTimer digitMode={4} anim={false} /></>
            : <span className="stream-passive-timer-m-text">STANDBY</span>
          }
        </div>
        <div className={`stream-passive-timer-sep ${growClass}`} />
        <div className={`stream-passive-timer-name start-hidden ${fadeClass}`}>
          {programName}
        </div>
      </div>
      <div className={`stream-passive-timer-hold-wrapper start-hidden ${fadeClass}`}>
        <div className={`stream-passive-timer-hold ${timerPaused ? '' : 'stream-hide'}`}>
          HOLD
        </div>
      </div>
    </div>
  );
}
