import { useEffect, useMemo, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { useLocation } from 'wouter';
import { getPlugins, Icon, hasIcon, useSetting, type PluginInfo } from '@its/sdk-react';
import './NavRail.css';

// Inter-plugin nav rail. One entry per plugin (not per view): Home top, plugins
// in discovery order, palette + Settings bottom. Collapsed shows icons/monograms;
// hover or focus expands it as an overlay, so the --its-rail-width offset stays
// fixed and content never reflows. Suppressed when turned off (showNavRail), in
// detached windows, on full-bleed routes (EXCLUDED_ROUTES), and on phones (where
// MobileNav handles navigation).

// Full-bleed surfaces, not nav destinations. /overlay is iss-live's OBS browser
// source. Host-side list so the rail stays plugin-agnostic without a manifest flag.
const EXCLUDED_ROUTES = new Set(['/overlay']);

// Rendered fully uppercase instead of Title-Cased in derived labels.
const ACRONYMS = new Set(['iss', 'gss', 'obs', 'its', 'gps', 'vhf']);

const RAIL_WIDTH = '3rem';
const MOBILE_QUERY = '(max-width: 700px)';

type PluginEntry = {
  pluginId: string;
  label: string;
  monogram: string;
  icon: string | null;
  priority: number; // higher floats nearer the top
  routes: string[]; // tab routes that mark this plugin active
  primaryRoute: string; // where clicking the entry navigates
};

type RailItem = {
  key: string;
  label: string;
  icon: string | null;
  monogram: string;
  routes: string[];
  kind: 'link' | 'action';
  href?: string;
  onActivate: () => void;
};

function titleCaseWord(w: string): string {
  if (!w) return w;
  if (ACRONYMS.has(w.toLowerCase())) return w.toUpperCase();
  return w[0].toUpperCase() + w.slice(1);
}

// "midas-ground" -> "Midas Ground"; "its-fleet" -> "Fleet". The `its-` prefix
// marks ownership, not identity, so it's dropped for display.
function deriveLabel(pluginId: string): string {
  const stripped = pluginId.startsWith('its-') ? pluginId.slice(4) : pluginId;
  return stripped.split('-').filter(Boolean).map(titleCaseWord).join(' ');
}

// First letters of up to two words, or first two letters of a single word.
function deriveMonogram(label: string): string {
  const words = label.split(' ').filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return label.slice(0, 2).toUpperCase();
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    setMatches(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

function buildPluginEntries(plugins: PluginInfo[]): PluginEntry[] {
  const entries: PluginEntry[] = [];
  for (const p of plugins) {
    if (!p.ui) continue;
    const routes = p.ui.mounts
      .filter(
        (m) =>
          m.target === 'tab' &&
          m.route &&
          m.title &&
          !EXCLUDED_ROUTES.has(m.route),
      )
      .map((m) => m.route as string);
    if (routes.length === 0) continue;
    const label = deriveLabel(p.id);
    entries.push({
      pluginId: p.id,
      label,
      monogram: deriveMonogram(label),
      icon: p.ui.icon ?? null,
      priority: p.ui.priority ?? 0,
      routes,
      primaryRoute: routes[0],
    });
  }
  // Higher priority first; ties keep discovery order via the explicit `index`
  // tiebreak (don't rely on sort stability).
  return entries
    .map((e, index) => ({ e, index }))
    .sort((a, b) => b.e.priority - a.e.priority || a.index - b.index)
    .map(({ e }) => e);
}

export function NavRail() {
  const [location, setLocation] = useLocation();
  const [pluginEntries, setPluginEntries] = useState<PluginEntry[]>([]);
  const [showNavRail] = useSetting<boolean>('global', 'showNavRail', true);

  const detached = useMemo(
    () => new URLSearchParams(window.location.search).get('detached') === '1',
    [],
  );
  const isMobile = useMediaQuery(MOBILE_QUERY);

  useEffect(() => {
    getPlugins()
      .then((plugins) => setPluginEntries(buildPluginEntries(plugins)))
      .catch((e) => console.warn('[navrail] /_plugins', e));
  }, []);

  const visible =
    showNavRail && !detached && !isMobile && !EXCLUDED_ROUTES.has(location);

  // Drive the layout offset off visibility alone (not /_plugins resolution) so
  // the gutter is reserved from first paint. Must sit above the early return.
  useEffect(() => {
    const el = document.documentElement;
    el.style.setProperty('--its-rail-width', visible ? RAIL_WIDTH : '0px');
    return () => el.style.removeProperty('--its-rail-width');
  }, [visible]);

  if (!visible) return null;

  const openPalette = () =>
    window.dispatchEvent(
      new CustomEvent('its:open-palette', { detail: { mode: 'tabs' } }),
    );

  const topItems: RailItem[] = [
    {
      key: 'home',
      label: 'Home',
      icon: 'home',
      monogram: 'H',
      routes: ['/'],
      kind: 'link',
      href: '/',
      onActivate: () => setLocation('/'),
    },
    ...pluginEntries.map<RailItem>((e) => ({
      key: e.pluginId,
      label: e.label,
      icon: e.icon,
      monogram: e.monogram,
      routes: e.routes,
      kind: 'link',
      href: e.primaryRoute,
      onActivate: () => setLocation(e.primaryRoute),
    })),
  ];

  const bottomItems: RailItem[] = [
    {
      key: 'palette',
      label: 'Switch view',
      icon: 'grid',
      monogram: 'K',
      routes: [],
      kind: 'action',
      onActivate: openPalette,
    },
    {
      key: 'settings',
      label: 'Settings',
      icon: 'settings',
      monogram: 'S',
      routes: ['/settings'],
      kind: 'link',
      href: '/settings',
      onActivate: () => setLocation('/settings'),
    },
  ];

  return (
    <nav class="navrail" aria-label="Platform navigation">
      <div class="navrail-group">
        {topItems.map((item) => (
          <RailItemView
            key={item.key}
            item={item}
            active={item.routes.includes(location)}
          />
        ))}
      </div>
      <div class="navrail-spacer" />
      <div class="navrail-group">
        {bottomItems.map((item) => (
          <RailItemView
            key={item.key}
            item={item}
            active={item.routes.includes(location)}
          />
        ))}
      </div>
    </nav>
  );
}

function RailItemView({
  item,
  active,
}: {
  item: RailItem;
  active: boolean;
}): JSX.Element {
  const glyph =
    item.icon && hasIcon(item.icon) ? (
      <Icon name={item.icon} />
    ) : (
      <span class="navrail-monogram">{item.monogram}</span>
    );
  const inner = (
    <>
      <span class="navrail-icon" aria-hidden="true">
        {glyph}
      </span>
      <span class="navrail-label">{item.label}</span>
    </>
  );
  const cls = `navrail-item${active ? ' navrail-item-active' : ''}`;

  // Blur after a pointer click so :focus-within doesn't pin the rail open once
  // the cursor leaves. Keyboard activation (e.detail === 0) keeps focus so Tab
  // users retain the expanded labels.
  const blurIfPointer = (e: MouseEvent) => {
    if (e.detail > 0) (e.currentTarget as HTMLElement).blur();
  };

  if (item.kind === 'link') {
    return (
      <a
        class={cls}
        href={item.href}
        aria-label={item.label}
        aria-current={active ? 'page' : undefined}
        title={item.label}
        onClick={(e) => {
          // Let modified clicks (new tab/window) use the native href.
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          item.onActivate();
          blurIfPointer(e);
        }}
      >
        {inner}
      </a>
    );
  }
  return (
    <button
      type="button"
      class={cls}
      aria-label={item.label}
      title={item.label}
      onClick={(e) => {
        item.onActivate();
        blurIfPointer(e);
      }}
    >
      {inner}
    </button>
  );
}
