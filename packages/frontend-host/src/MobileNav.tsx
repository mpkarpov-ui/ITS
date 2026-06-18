// Floating nav button for touch-only screens (no keyboard for the palette's
// Ctrl/Cmd+K). Hidden above 700px and dispatches the same its:open-palette
// event the palette listens for, so there's no parallel navigator UI.

import './MobileNav.css';

function openPalette() {
  window.dispatchEvent(
    new CustomEvent('its:open-palette', { detail: { mode: 'tabs' } }),
  );
}

export function MobileNav() {
  return (
    <button
      type="button"
      class="its-mobile-nav"
      aria-label="Open navigator"
      onClick={openPalette}
    >
      {/* Inline SVG so it inherits currentColor and themes correctly. */}
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
      >
        <line x1="4" y1="7" x2="20" y2="7" />
        <line x1="4" y1="12" x2="20" y2="12" />
        <line x1="4" y1="17" x2="20" y2="17" />
      </svg>
    </button>
  );
}
