// Inline-SVG icon registry shared by the nav rail, command palette, and plugin
// surfaces. Stroke icons inherit currentColor and fill their parent's box, so
// callers control size and theming. Plugins opt in via `[ui] icon = "name"`;
// unknown/unset names return null and the caller falls back to a monogram.

import type { JSX } from 'preact';

// Each entry is the inner geometry of a 24x24 viewBox, kept to simple
// primitives so they stay readable and editable.
const ICONS: Record<string, JSX.Element> = {
  home: (
    <>
      <path d="M3 11 12 3l9 8" />
      <path d="M6 9.5V20h12V9.5" />
      <path d="M10 20v-5h4v5" />
    </>
  ),
  // Sliders, not a gear; a small gear blurs into a sun at rail size.
  settings: (
    <>
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="20" y2="17" />
      <circle cx="9" cy="7" r="2" />
      <circle cx="15" cy="12" r="2" />
      <circle cx="8" cy="17" r="2" />
    </>
  ),
  // 2x2 grid: view switcher.
  grid: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </>
  ),
  // Camcorder body + lens; for the livestream production plugin.
  camera: (
    <>
      <rect x="2" y="6" width="13" height="12" rx="2" />
      <path d="M15 12 L21 7.5 L21 16.5 Z" />
    </>
  ),
  // Radio waves around a dot: signal/broadcast.
  broadcast: (
    <>
      <circle cx="12" cy="12" r="2" />
      <path d="M8.6 8.6a5 5 0 0 0 0 6.8" />
      <path d="M15.4 8.6a5 5 0 0 1 0 6.8" />
      <path d="M6.2 6.2a9 9 0 0 0 0 11.6" />
      <path d="M17.8 6.2a9 9 0 0 1 0 11.6" />
    </>
  ),
  // Stacked rack units: server/fleet.
  server: (
    <>
      <rect x="4" y="4" width="16" height="7" rx="1.5" />
      <rect x="4" y="13" width="16" height="7" rx="1.5" />
      <line x1="7.5" y1="7.5" x2="7.5" y2="7.5" />
      <line x1="7.5" y1="16.5" x2="7.5" y2="16.5" />
    </>
  ),
  // Suspension bridge: deck, piers, cable arc.
  bridge: (
    <>
      <line x1="3" y1="16" x2="21" y2="16" />
      <path d="M3 16C7 9 17 9 21 16" />
      <line x1="8" y1="16" x2="8" y2="11" />
      <line x1="16" y1="16" x2="16" y2="11" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3" />
      <line x1="12.5" y1="15" x2="16" y2="15" />
    </>
  ),
  // Bell with clapper: alerts. Mirrors the inline BellIcon in Home.tsx.
  bell: (
    <>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </>
  ),
};

export function hasIcon(name: string | null | undefined): boolean {
  return !!name && name in ICONS;
}

export function Icon({ name }: { name: string }): JSX.Element | null {
  const inner = ICONS[name];
  if (!inner) return null;
  return (
    <svg
      width="100%"
      height="100%"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {inner}
    </svg>
  );
}
