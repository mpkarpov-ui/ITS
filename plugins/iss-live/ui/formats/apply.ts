// Apply a preset: overlay-state global, optional name-tag, optional OBS scene,
// optional audio preset. Branches are independent so an OBS failure (scene
// missing, not connected) still lets the overlay state update.

import { globals } from '@its/sdk-react';
import type { OverlayVisibility } from '@its/contracts/iss-live';
import { obsService } from '../services/obs';
import { sceneCycler } from '../services/cycler';
import type { AudioPreset, FormatFile, Preset } from './types';

const DEFAULT_VIS: OverlayVisibility = {
  spot: false,
  top_timer: false,
  timeline: false,
  tag: false,
  t_clock: false,
  single_stage_mode: false,
};

export interface ApplyResult {
  errors: string[];     // soft errors (OBS not connected, scene missing, etc.)
}

export async function applyPreset(
  preset: Preset,
  format: FormatFile,
  currentVis: OverlayVisibility | null,
): Promise<ApplyResult> {
  const errors: string[] = [];

  // Merge over current visibility so a preset declaring only { spot: true }
  // leaves the other layers untouched.
  if (preset.overlay_state) {
    const next: OverlayVisibility = {
      ...(currentVis ?? DEFAULT_VIS),
      ...preset.overlay_state,
    };
    globals.issLive.overlayVisibility.update(next);
  }

  // Stage name-tag text even when its visibility is off, so a later preset can
  // flip the flag to reveal it (legacy trick).
  if (preset.target_desc) {
    globals.issLive.nameTag.update({
      title: preset.target_desc.title ?? '',
      subtitle: preset.target_desc.subtitle ?? '',
    });
  }

  // Switch to the preset's first scene. Any preset apply ends a running
  // rotation; a cycling preset (multiple scenes + interval) then starts a fresh
  // one off the first scene. The cycler is a singleton, so rotation persists
  // regardless of which control tab is shown.
  const scenes = preset.scenes ?? (preset.scene ? [preset.scene] : []);
  const cycling = scenes.length > 1 && !!preset.cycle_interval;
  sceneCycler.stop();
  const firstScene = scenes[0];
  if (firstScene) {
    try {
      await obsService.setScene(firstScene);
      if (cycling) sceneCycler.start(preset.id, scenes, preset.cycle_interval!);
    } catch (e: any) {
      errors.push(e?.message ?? String(e));
    }
  }

  // Look up the audio preset by key and apply each entry. Missing key or
  // missing OBS input is a soft error.
  if (preset.audio_preset) {
    const ap: AudioPreset | undefined = format.audio_presets?.[preset.audio_preset];
    if (!ap) {
      errors.push(`Audio preset "${preset.audio_preset}" not declared in this format`);
    } else {
      for (const [inputName, shouldBeOn] of Object.entries(ap)) {
        try {
          await obsService.setInputMute(inputName, !shouldBeOn);
        } catch (e: any) {
          errors.push(e?.message ?? String(e));
        }
      }
    }
  }

  return { errors };
}

// Validate a preset's scene refs against the format's declared scenes and
// (if connected) OBS's actual scenes. Returns warnings shown inline by the
// Presets tab.
export function validatePreset(
  preset: Preset,
  format: FormatFile,
  obsScenes: string[],
): string[] {
  const warnings: string[] = [];
  const allScenes = preset.scenes ?? (preset.scene ? [preset.scene] : []);
  for (const s of allScenes) {
    if (format.scenes && format.scenes.length > 0 && !format.scenes.includes(s)) {
      warnings.push(`Scene "${s}" not declared in format`);
    }
    if (obsScenes.length > 0 && !obsScenes.includes(s)) {
      warnings.push(`Scene "${s}" not in OBS`);
    }
  }
  if (preset.audio_preset && !format.audio_presets?.[preset.audio_preset]) {
    warnings.push(`Audio preset "${preset.audio_preset}" not declared`);
  }
  return warnings;
}
