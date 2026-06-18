// useGlobal wrappers that fill defaults for unset keys so consumers skip
// null-checks. Defaults mirror the Pydantic class (the source of truth).

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

export function useOverlayVisibility(): [OverlayVisibility, (v: OverlayVisibility) => void, { ready: boolean }] {
  const [value, set, meta] = useGlobal(globals.issLive.overlayVisibility);
  return [value ?? DEFAULT_VIS, set, meta];
}

export function useNameTag(): [NameTag, (v: NameTag) => void, { ready: boolean }] {
  const [value, set, meta] = useGlobal(globals.issLive.nameTag);
  return [value ?? DEFAULT_NAME_TAG, set, meta];
}

export function useIdleText(): [IdleText, (v: IdleText) => void, { ready: boolean }] {
  const [value, set, meta] = useGlobal(globals.issLive.idleText);
  return [value ?? DEFAULT_IDLE_TEXT, set, meta];
}
