// Scene cycler: drives auto-rotation for cycling presets (scenes[] +
// cycle_interval). A module singleton rather than a component timer, so rotation
// survives control-deck tab switches; it stops only on a new preset, a manual
// scene pick, or OBS disconnect.

import { obsService } from './obs';

export interface CyclerState {
  presetId: string | null;   // preset currently cycling; null when idle
  scenes: string[];
  index: number;             // index of the scene last switched to
  intervalS: number;
  nextSwitchAt: number;      // epoch ms of the next switch; 0 when idle
}

type Subscriber = (state: CyclerState) => void;

const IDLE: CyclerState = { presetId: null, scenes: [], index: 0, intervalS: 0, nextSwitchAt: 0 };

class SceneCycler {
  private state: CyclerState = IDLE;
  private timer: ReturnType<typeof setInterval> | null = null;
  private subscribers = new Set<Subscriber>();

  constructor() {
    // Stop the moment OBS drops; setScene would just throw every tick otherwise.
    obsService.subscribe((obs) => {
      if (!obs.connected && this.timer) this.stop();
    });
  }

  // Begin cycling `scenes` every `intervalS` seconds. The caller has already
  // switched to scenes[0], so the first tick advances to scenes[1]. No-op for
  // fewer than two scenes or a non-positive interval.
  start(presetId: string, scenes: string[], intervalS: number): void {
    this.stop();
    if (scenes.length < 2 || intervalS <= 0) return;
    this.state = { presetId, scenes, index: 0, intervalS, nextSwitchAt: Date.now() + intervalS * 1000 };
    this.emit();
    this.timer = setInterval(() => this.advance(), intervalS * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.state.presetId !== null) {
      this.state = IDLE;
      this.emit();
    }
  }

  private advance(): void {
    const next = (this.state.index + 1) % this.state.scenes.length;
    this.state = {
      ...this.state,
      index: next,
      nextSwitchAt: Date.now() + this.state.intervalS * 1000,
    };
    obsService
      .setScene(this.state.scenes[next])
      .catch((e) => console.warn('[cycler] setScene failed:', e));
    this.emit();
  }

  getState(): CyclerState {
    return this.state;
  }

  subscribe(cb: Subscriber): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  private emit(): void {
    for (const cb of this.subscribers) {
      try {
        cb(this.state);
      } catch (e) {
        console.error('[cycler] subscriber error:', e);
      }
    }
  }
}

export const sceneCycler = new SceneCycler();
