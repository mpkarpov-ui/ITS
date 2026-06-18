// Internal nav for midas-ground: view switcher, data-flow pill, and the target
// dropdown (the canonical place to pick which MIDAS the page shows). Selection
// lives in TargetContext so every view stays in lockstep.

import { useLocation } from 'wouter';
import { useStaleAfter } from '@its/sdk-react';
import { useMidasTlm } from '../hooks';
import { useTarget } from '../TargetContext';
import { StatusBadge } from './StatusBadge';
import './MidasNav.css';

const tabs: { route: string; label: string }[] = [
  { route: '/flight', label: 'Flight' },
  { route: '/commanding', label: 'Commanding' },
  { route: '/map', label: 'Map' },
];

export function MidasNav() {
  const [location, setLocation] = useLocation();
  const { target, setTarget, options } = useTarget();
  const { lastSeen } = useMidasTlm();
  // 3s "is data flowing at all" threshold. CommandingView gates pyro buttons on
  // a tighter 2s, a separate concern.
  const stale = useStaleAfter(lastSeen, 3000);

  return (
    <nav class="midas-nav">
      <span class="midas-nav-title">MIDAS GROUND</span>
      {/* Desktop / tablet tab row; CSS hides it on phone. */}
      <div class="midas-nav-tabs">
        {tabs.map((t) => {
          const active = location === t.route;
          return (
            <button
              key={t.route}
              class={`midas-nav-item ${active ? 'midas-nav-active' : ''}`}
              onClick={() => setLocation(t.route)}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {/* Phone: same routes as a select. Value falls back to the first tab when
          the current location isn't in the list. */}
      <select
        class="midas-nav-tabs-mobile midas-nav-select"
        value={tabs.some((t) => t.route === location) ? location : tabs[0].route}
        onChange={(e) => setLocation((e.target as HTMLSelectElement).value)}
      >
        {tabs.map((t) => (
          <option key={t.route} value={t.route}>
            {t.label}
          </option>
        ))}
      </select>
      <div class="midas-nav-spacer" />
      <StatusBadge lastSeen={lastSeen} stale={stale} />
      <label class="midas-nav-rocket">
        <span class="midas-nav-rocket-label">target</span>
        <select
          class="midas-nav-select"
          value={target}
          disabled={options.length === 0}
          onChange={(e) => setTarget((e.target as HTMLSelectElement).value)}
        >
          {/* Empty until a feather streams (or after the cache is cleared). */}
          {options.length === 0 && <option value="">— no targets —</option>}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
    </nav>
  );
}
