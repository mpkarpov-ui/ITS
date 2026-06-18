// Parsed shape of a format YAML. The wire form is the raw string in
// globals.issLive.formats.entries[name]; this is the post-yaml.load view.
// Most fields are optional so a half-finished format still parses and the
// overlay degrades gracefully.

export interface TimelineRow {
  t: string;       // T-minus display string, e.g. "5:30:00"
  desc: string;
}

// Camera-home for the map overlay (?mode=map).
export interface LaunchSite {
  lat: number;
  lon: number;
}

export interface PresetTargetDesc {
  title?: string;
  subtitle?: string;
}

export interface PresetOverlayState {
  spot?: boolean;
  top_timer?: boolean;
  timeline?: boolean;
  tag?: boolean;
  t_clock?: boolean;
  single_stage_mode?: boolean;
}

export interface Preset {
  id: string;
  name: string;
  description?: string;
  scene?: string;                // single scene (OBS scene name)
  scenes?: string[];             // multi-scene cycling list
  cycle_interval?: number;       // seconds; parsed but not yet acted on
  audio_preset?: string;         // key into FormatFile.audio_presets
  overlay_state?: PresetOverlayState;
  target_desc?: PresetTargetDesc;
}

// Audio preset: input name -> on/off (true = unmuted, false = muted)
export type AudioPreset = Record<string, boolean>;

// One social handle line on the goodbye screen, e.g. "@handle on Instagram".
export interface SocialHandle {
  handle: string;
  platform: string;
}

// Mission content for the pre / idle / goodbye interstitial screens. All
// optional: the overlay falls back to legacy default headlines and a solid
// dark cover when a field (or the whole block) is absent. Background values
// are URLs resolved at runtime, so they can point at a hosted image or a file
// served from the site root.
export interface IdleScreenConfig {
  subtitle?: string;               // under the headline on pre/idle/goodbye
  pre_background?: string;         // bg image url for the pre screen
  idle_background?: string;        // bg image url for idle + goodbye screens
  footer_top?: string;            // large footer line (e.g. "Spaceshot")
  footer_bottom?: string;         // small footer line (e.g. "Illinois Space Society")
  goodbye_text?: string;          // body paragraph on the goodbye screen
  social_handles?: SocialHandle[]; // handles listed on the goodbye screen
  headline_pre?: string;          // override default "Starting soon!"
  headline_idle?: string;         // override default "We'll be back soon!"
  headline_goodbye?: string;      // override default "Thank You!"
}

export interface FormatFile {
  name: string;
  version?: number;

  // Mission text - replaces the hardcoded strings in the overlay.
  program_name?: string;
  booster_target?: string;       // midas instance key feeding the booster column
  sustainer_target?: string;     // midas instance key feeding the sustainer column
  launch_site?: LaunchSite;      // map overlay camera home

  timeline?: TimelineRow[];
  fun_facts?: string[];
  sponsors?: string[];
  idle_screen?: IdleScreenConfig;

  // Broadcast knobs
  scenes?: string[];             // declared OBS scene names; used for preset validation
  audio_presets?: Record<string, AudioPreset>;
  presets?: Preset[];
}
