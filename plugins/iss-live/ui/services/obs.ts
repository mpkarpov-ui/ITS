// OBS bridge: singleton over obs-websocket-js with auto-reconnect/backoff.
// Lives in the frontend rather than a Python plugin because OBS WebSocket runs
// on the broadcast machine, this deck is its only consumer, and routing
// browser-native calls through the bus would just add hops. Each operator
// browser holds its own connection; OBS handles multiple clients.

import { OBSWebSocket } from 'obs-websocket-js';

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000];
const MAX_RECONNECT_ATTEMPTS = 8;

export interface ObsInputState {
  muted: boolean;
  kind?: string;
}

export interface ObsState {
  connected: boolean;
  connecting: boolean;
  currentScene: string | null;
  sceneList: string[];
  streaming: boolean;
  recording: boolean;
  inputs: Record<string, ObsInputState>;
  statusMessage: string;
}

type Subscriber = (state: ObsState) => void;

class ObsService {
  private obs = new OBSWebSocket();
  private state: ObsState = {
    connected: false,
    connecting: false,
    currentScene: null,
    sceneList: [],
    streaming: false,
    recording: false,
    inputs: {},
    statusMessage: 'Not connected',
  };
  private subscribers = new Set<Subscriber>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private autoReconnect = false;
  private lastUrl: string | null = null;
  private lastPassword: string | undefined;

  constructor() {
    // disconnect() clears autoReconnect first, so this only reconnects on
    // unintentional drops.
    this.obs.on('ConnectionClosed', () => {
      this.update({ connected: false, statusMessage: 'Connection closed' });
      if (this.autoReconnect) this.scheduleReconnect();
    });
    this.obs.on('ConnectionError', () => {
      this.update({ connected: false, connecting: false, statusMessage: 'Connection error' });
    });

    // Mute changes patch the cache in place; create/remove/rename force a full
    // refreshInputs since the input set changed.
    this.obs.on('CurrentProgramSceneChanged', ({ sceneName }) => {
      this.update({ currentScene: sceneName });
      this.refreshInputs();
    });
    this.obs.on('InputMuteStateChanged', ({ inputName, inputMuted }) => {
      const inputs = { ...this.state.inputs };
      if (inputs[inputName]) {
        inputs[inputName] = { ...inputs[inputName], muted: inputMuted };
        this.update({ inputs });
      }
    });
    this.obs.on('InputCreated', () => this.refreshInputs());
    this.obs.on('InputRemoved', () => this.refreshInputs());
    this.obs.on('InputNameChanged', () => this.refreshInputs());

    this.obs.on('StreamStateChanged', ({ outputActive }) => {
      this.update({ streaming: outputActive });
    });
    this.obs.on('RecordStateChanged', ({ outputActive }) => {
      this.update({ recording: outputActive });
    });
    this.obs.on('SceneListChanged', ({ scenes }) => {
      this.update({ sceneList: scenes.map((s: any) => s.sceneName ?? s) });
    });
  }

  private update(partial: Partial<ObsState>) {
    this.state = { ...this.state, ...partial };
    for (const cb of this.subscribers) {
      try { cb(this.state); } catch (e) { console.error('[ObsService] subscriber error:', e); }
    }
  }

  // Backoff capped by RECONNECT_DELAYS[-1]; gives up after
  // MAX_RECONNECT_ATTEMPTS rather than hammering OBS forever.
  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      this.autoReconnect = false;
      this.update({ statusMessage: `Gave up after ${MAX_RECONNECT_ATTEMPTS} attempts. Click CONNECT to retry.` });
      return;
    }
    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    this.update({ statusMessage: `Reconnecting in ${delay / 1000}s... (${this.reconnectAttempt + 1}/${MAX_RECONNECT_ATTEMPTS})` });
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.reconnectAttempt++;
      if (this.lastUrl !== null) await this.connect(this.lastUrl, this.lastPassword, true);
    }, delay);
  }

  async connect(url: string, password?: string, isReconnect = false): Promise<void> {
    if (this.state.connected) return;
    this.lastUrl = url;
    this.lastPassword = password;
    this.autoReconnect = true;
    if (!isReconnect) this.reconnectAttempt = 0;
    this.update({ connecting: true, statusMessage: 'Connecting...' });
    try {
      await this.obs.connect(url, password);
      this.reconnectAttempt = 0;
      this.update({ connected: true, connecting: false, statusMessage: 'Connected' });
      await this.fetchInitialState();
    } catch (e: any) {
      this.update({ connected: false, connecting: false, statusMessage: `Failed to connect: ${e?.message ?? e}` });
      if (this.autoReconnect) this.scheduleReconnect();
    }
  }

  async disconnect(): Promise<void> {
    this.autoReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.obs.disconnect();
    this.update({
      connected: false,
      connecting: false,
      currentScene: null,
      sceneList: [],
      streaming: false,
      recording: false,
      inputs: {},
      statusMessage: 'Disconnected',
    });
  }

  private async refreshInputs(): Promise<void> {
    try {
      const { inputs } = await this.obs.call('GetInputList');
      const next: Record<string, ObsInputState> = {};
      for (const input of inputs as any[]) {
        try {
          const { inputMuted } = await this.obs.call('GetInputMute', { inputName: input.inputName });
          next[input.inputName] = { muted: inputMuted, kind: input.inputKind };
        } catch {
          // Input doesn't support muting (e.g. video sources); skip.
        }
      }
      this.update({ inputs: next });
    } catch (e) {
      console.warn('[ObsService] Failed to fetch input list:', e);
    }
  }

  private async fetchInitialState(): Promise<void> {
    try {
      const { currentProgramSceneName, scenes } = await this.obs.call('GetSceneList');
      this.update({
        currentScene: currentProgramSceneName,
        sceneList: (scenes as any[]).map((s) => s.sceneName),
      });
    } catch (e) {
      console.warn('[ObsService] Failed to fetch scene list:', e);
    }
    await this.refreshInputs();
    try {
      const { outputActive } = await this.obs.call('GetStreamStatus');
      this.update({ streaming: outputActive });
    } catch { /* stream not configured in OBS; leave default */ }
    try {
      const { outputActive } = await this.obs.call('GetRecordStatus');
      this.update({ recording: outputActive });
    } catch { /* recording not configured; leave default */ }
  }

  async setScene(sceneName: string): Promise<void> {
    if (!this.state.connected) throw new Error('Not connected to OBS');
    try {
      await this.obs.call('SetCurrentProgramScene', { sceneName });
    } catch {
      throw new Error(`Scene "${sceneName}" not found in OBS`);
    }
  }

  async setInputMute(inputName: string, muted: boolean): Promise<void> {
    if (!this.state.connected) throw new Error('Not connected to OBS');
    try {
      await this.obs.call('SetInputMute', { inputName, inputMuted: muted });
    } catch {
      throw new Error(`Input "${inputName}" not found in OBS`);
    }
  }

  async setInputVolume(inputName: string, volumeDb: number): Promise<void> {
    if (!this.state.connected) return;
    await this.obs.call('SetInputVolume', { inputName, inputVolumeDb: volumeDb });
  }

  async startStreaming(): Promise<void> {
    if (!this.state.connected) return;
    await this.obs.call('StartStream');
  }

  async stopStreaming(): Promise<void> {
    if (!this.state.connected) return;
    await this.obs.call('StopStream');
  }

  async startRecording(): Promise<void> {
    if (!this.state.connected) return;
    await this.obs.call('StartRecord');
  }

  async stopRecording(): Promise<void> {
    if (!this.state.connected) return;
    await this.obs.call('StopRecord');
  }

  getState(): ObsState {
    return this.state;
  }

  subscribe(cb: Subscriber): () => void {
    this.subscribers.add(cb);
    return () => { this.subscribers.delete(cb); };
  }
}

export const obsService = new ObsService();
