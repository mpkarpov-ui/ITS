// Separate from control/globals.ts so the overlay chunk doesn't pull in
// control-deck-only modules.

import { globals, useGlobal } from '@its/sdk-react';
import type { IdleText, NameTag, OverlayVisibility } from '@its/contracts/iss-live';

const DEFAULT_VIS: OverlayVisibility = {
  spot: false,
  top_timer: false,
  timeline: false,
  tag: false,
  t_clock: false,
  single_stage_mode: false,
};
const DEFAULT_NAME_TAG: NameTag = { title: '', subtitle: '' };
const DEFAULT_IDLE_TEXT: IdleText = { reason_text: '' };

export function useOverlayVisibility(): OverlayVisibility {
  const [value] = useGlobal(globals.issLive.overlayVisibility);
  return value ?? DEFAULT_VIS;
}

export function useNameTagValue(): NameTag {
  const [value] = useGlobal(globals.issLive.nameTag);
  return value ?? DEFAULT_NAME_TAG;
}

export function useIdleTextValue(): IdleText {
  const [value] = useGlobal(globals.issLive.idleText);
  return value ?? DEFAULT_IDLE_TEXT;
}
