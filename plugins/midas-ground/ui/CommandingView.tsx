import { useEffect, useState } from 'preact/hooks';
import { globals, useGlobal, useStaleAfter } from '@its/sdk-react';
import { useMidasShell, useMidasTlm } from './hooks';
import { CommandConsole, useCommandConsole } from './CommandConsole';
import { Button } from './components/Button';
import { MidasNav } from './components/MidasNav';
import { FlightCountTimer } from './components/Timer';
import { ValueGroup } from './components/ValueDisplay';
import './CommandingView.css';

const PIN = 155; // matches GSS; accident-prevention gate, not security
const PIN_STORAGE_KEY = 'midas:cmd-pin';

export function CommandingView() {
  const [pinPassed, setPinPassed] = useState(false);

  // Skip the prompt if a matching pin is already stored in this browser.
  // Wrong / cancelled entries clear any stale stored value.
  function checkPin() {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(PIN_STORAGE_KEY);
    } catch {
      // Private mode etc: fall through to prompt.
    }
    if (stored !== null && Number(stored) === PIN) {
      setPinPassed(true);
      return;
    }
    const entered = prompt('[pin input] Input commanding pin');
    if (entered !== null && Number(entered) === PIN) {
      try {
        localStorage.setItem(PIN_STORAGE_KEY, entered);
      } catch {}
      setPinPassed(true);
    } else {
      try {
        localStorage.removeItem(PIN_STORAGE_KEY);
      } catch {}
      setPinPassed(false);
    }
  }

  useEffect(() => {
    checkPin();
  }, []);

  if (!pinPassed) {
    return (
      <div class="midas-page">
        <MidasNav />
        <div class="cmd-unauth-page">
          <svg
            class="cmd-unauth-icon"
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect x="5" y="11" width="14" height="9" rx="1.5" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
          <div class="cmd-unauth">Commanding locked</div>
          <div class="cmd-unauth-sub">
            Enter the operator pin to unlock commands.
          </div>
          <button class="cmd-unauth-retry" onClick={checkPin}>
            Enter pin
          </button>
        </div>
      </div>
    );
  }

  return <Operator />;
}

function TerminalIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <polyline points="5 8 9 12 5 16" />
      <line x1="12" y1="16" x2="19" y2="16" />
    </svg>
  );
}

function Operator() {
  // LOS = no fresh packet for 2s, or none ever (lastSeen===null guards the
  // pre-data state since useStaleAfter returns false until lastSeen is set).
  const { value: t, lastSeen } = useMidasTlm();
  const stale = useStaleAfter(lastSeen, 2000);
  const isLos = lastSeen === null || stale;

  const { send } = useMidasShell();

  const [timer, setTimer] = useGlobal(globals.midasGround.timer);

  // Console api (transcript + cmd_result subscription) lives here so the log
  // keeps filling while the modal opens and closes.
  const consoleApi = useCommandConsole();
  const [consoleOpen, setConsoleOpen] = useState(false);

  const fsmState = t?.FSM_State ?? -1;
  const isPyroTest = fsmState === 1;
  const contA = t?.pyro_a ?? 0;
  const pyroEnabled = isPyroTest && contA > 0;

  function setCountdown(seconds: number) {
    const ms = seconds * 1000;
    setTimer({ t0: Date.now() + ms, paused: true, paused_value: ms });
  }

  function togglePause() {
    if (!timer) {
      setTimer({ t0: Date.now(), paused: true, paused_value: 0 });
      return;
    }
    const now = Date.now();
    if (timer.paused) {
      // Unpausing: anchor t0 so the live count resumes at paused_value.
      setTimer({
        t0: now + timer.paused_value,
        paused: false,
        paused_value: timer.paused_value,
      });
    } else {
      // Pausing: freeze the current live countdown into paused_value so
      // pause/unpause resumes where it left off (not the original setCountdown).
      const current = timer.t0 - now;
      setTimer({
        t0: timer.t0,
        paused: true,
        paused_value: current,
      });
    }
  }

  function clearTimer() {
    const now = Date.now();
    setTimer({ t0: now, paused: false, paused_value: 0 });
  }

  return (
    <div class="midas-page">
      <MidasNav />
      <div class="cmd-view">
        <FlightCountTimer />

        <ValueGroup label="MIDAS Pyro" hidden={isLos} hiddenLabelText="NO CONNECTION">
          <div class="cmd-split">
            <div class="cmd-group">
              <Button variant="blue" onClick={() => send('safe')}>FORCE SAFE</Button>
              <Button variant="yellow" onClick={() => send('pt')}>PYRO TEST</Button>
            </div>
            <div class="cmd-group">
              <Button variant="red" disabled={!pyroEnabled} onClick={() => send('fire', 'A')}>Fire A</Button>
              <Button variant="red" disabled={!pyroEnabled} onClick={() => send('fire', 'B')}>Fire B</Button>
              <Button variant="red" disabled={!pyroEnabled} onClick={() => send('fire', 'C')}>Fire C</Button>
              <Button variant="red" disabled={!pyroEnabled} onClick={() => send('fire', 'D')}>Fire D</Button>
            </div>
          </div>
          {!pyroEnabled && !isLos && (
            <p class="cmd-hint">
              Fire buttons unlock once state is PYRO_TEST and continuity reads above 0V.
            </p>
          )}
        </ValueGroup>

        <ValueGroup label="MIDAS Control" hidden={isLos} hiddenLabelText="NO CONNECTION">
          <div class="cmd-split">
            <div class="cmd-group">
              <Button variant="yellow" onClick={() => send('kfr')}>RESET KF</Button>
              <Button variant="yellow" onClick={() => send('cam', 'on')}>CAM ON</Button>
              <Button variant="yellow" onClick={() => send('cam', 'off')}>CAM OFF</Button>
              <Button variant="blue" onClick={() => send('cam', 'toggle')}>TOGGLE VMUX</Button>
            </div>
            <div class="cmd-group">
              <Button variant="yellow" onClick={() => send('safe')}>FORCE SAFE</Button>
              <Button variant="yellow" onClick={() => send('arm')}>FORCE PAD</Button>
            </div>
          </div>
        </ValueGroup>

        <ValueGroup label="MIDAS Calibration" hidden={isLos} hiddenLabelText="NO CONNECTION">
          <div class="cmd-row">
            <Button variant="yellow" onClick={() => send('calib', 'accel')}>CALIB ACCEL</Button>
            <Button variant="yellow" onClick={() => send('calib', 'mag')}>CALIB MAG</Button>
          </div>
        </ValueGroup>

        <ValueGroup label="Misc Control">
          <div class="cmd-split">
            <div class="cmd-group">
              <Button variant="yellow" onClick={togglePause}>Toggle Pause</Button>
              <Button onClick={clearTimer}>0:00 (NO PAUSE)</Button>
              <Button onClick={() => setCountdown(30)}>0:30</Button>
              <Button onClick={() => setCountdown(60)}>1:00</Button>
              <Button onClick={() => setCountdown(300)}>5:00</Button>
              <Button
                onClick={() => {
                  const s = Number(prompt('[time input] Countdown in SECONDS'));
                  if (Number.isFinite(s)) setCountdown(s);
                }}
              >
                CUSTOM
              </Button>
            </div>
            {/* Neutral variant: a tool, not a rocket command. */}
            <div class="cmd-group">
              <Button onClick={() => setConsoleOpen(true)}>
                <TerminalIcon />
                FEATHER CONSOLE
              </Button>
            </div>
          </div>
        </ValueGroup>
      </div>

      <CommandConsole
        open={consoleOpen}
        onClose={() => setConsoleOpen(false)}
        api={consoleApi}
      />
    </div>
  );
}
