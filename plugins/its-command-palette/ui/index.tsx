import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useLocation } from 'wouter';
import {
  getPlugins,
  getPaletteCommands,
  getSetting,
  hasIcon,
  Icon,
  registerCommand,
  setSetting,
  subscribePaletteCommands,
  usePersisted,
  type PaletteCommand,
} from '@its/sdk-react';

// Overlay-mounted Ctrl/Cmd+K (tabs) / Ctrl/Cmd+P (commands) switcher.
// Command mode also triggers by typing `>` as the first character.
// Self-hides in detached windows. Plugins register commands via
// registerCommand from @its/sdk-react.

interface Tab {
  route: string;
  title: string;
  pluginId: string;
  // Manifest-declared glyph name (host-owned `home` / `settings` count too).
  // null = no icon registered; we render a monogram fallback.
  icon: string | null;
}

type Row =
  | {
      kind: 'tab';
      route: string;
      title: string;
      sub: string;
      source: string;
      pluginId: string;
      icon: string | null;
    }
  | {
      kind: 'command';
      command: PaletteCommand;
      source: string;
    };

// _host (the pseudo-pluginId for /, /settings) reads as "host"; no source
// means platform-wide; otherwise the plugin id.
function sourceLabel(raw: string | undefined): string {
  if (raw === undefined) return 'platform';
  if (raw === '_host') return 'host';
  return raw;
}

// Recents-map key. Tabs key by route, commands by id; separate buckets
// keep the keyspaces from colliding.
function rowKey(row: Row): string {
  return row.kind === 'tab' ? row.route : row.command.id;
}

// Match score buckets, strongest evidence wins; 0 = no match (filtered out).
//   200 exact, 150 prefix, 120 word-start/acronym, 80 substring, 40 subsequence.
// A small length penalty breaks ties toward the tighter target.
// Word split covers kebab ids, snake fields, and route segments.
const WORD_SPLIT = /[\s\-_./]+/;

function scoreField(query: string, target: string): number {
  if (!query) return 1;
  if (query === target) return 200;
  if (target.startsWith(query)) return 150 - lenPenalty(target);
  // Acronym: query chars vs each word's first letter.
  const starts = target.split(WORD_SPLIT).filter(Boolean).map((w) => w[0]);
  let qi = 0;
  for (const c of starts) {
    if (qi < query.length && c === query[qi]) qi++;
  }
  if (qi === query.length) return 120 - lenPenalty(target);
  // Substring, weighted earlier-is-better.
  const sub = target.indexOf(query);
  if (sub >= 0) return 80 - Math.min(sub, 30) - lenPenalty(target);
  // Subsequence: query chars in order, gaps allowed.
  let ti = 0;
  for (const c of query) {
    while (ti < target.length && target[ti] !== c) ti++;
    if (ti >= target.length) return 0;
    ti++;
  }
  return 40 - lenPenalty(target);
}
function lenPenalty(t: string): number {
  return Math.min(t.length, 40);
}

// Tries every field on a row, returns the best score.
function scoreRow(query: string, row: Row, recents: RecentsByKind): number {
  if (!query) {
    // Empty query: base score keeps every row visible; recency sorts the head.
    const base = 1;
    return base + recencyBoost(row, recents);
  }
  const fields: string[] =
    row.kind === 'tab'
      ? [row.title, row.route, row.pluginId]
      : [
          row.command.title,
          row.command.id,
          row.command.hint ?? '',
        ];
  let best = 0;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f) continue;
    const raw = scoreField(query, f.toLowerCase());
    if (raw === 0) continue;
    // Title is the primary label; id/route are reduced-weight backup matches.
    const weight = i === 0 ? 1 : 0.6;
    const weighted = raw * weight;
    if (weighted > best) best = weighted;
  }
  if (best === 0) return 0;
  return best + recencyBoost(row, recents);
}

type RecentEntry = { count: number; ts: number };
type RecentMap = Record<string, RecentEntry>;
type RecentsByKind = { tabs: RecentMap; commands: RecentMap };
const EMPTY_RECENTS: RecentsByKind = { tabs: {}, commands: {} };
const RECENTS_CAP = 50; // remembered entries per kind
const RECENT_BOOST_MAX = 12;

// Boost falls off over 7 days; older returns 0.
function recencyBoost(row: Row, recents: RecentsByKind): number {
  const key = rowKey(row);
  const bucket = row.kind === 'tab' ? recents.tabs : recents.commands;
  const entry = bucket[key];
  if (!entry) return 0;
  const ageDays = (Date.now() - entry.ts) / 86_400_000;
  if (ageDays > 7) return 0;
  // Recency dominates; frequency adds a small tail so daily-use rows stay sticky.
  const recency = (1 - ageDays / 7) * 9;
  const frequency = Math.min(3, Math.log2(entry.count + 1));
  return Math.min(RECENT_BOOST_MAX, recency + frequency);
}

// Parses a command's free-text `shortcut` (e.g. "Ctrl+Shift+L") into a Binding
// the global keydown listener matches against. Kept here, not in the SDK's
// registerCommand, so the SDK stays display-only.
// `Mod` resolves to Cmd on macOS and Ctrl elsewhere; prefer it over Ctrl.

type Binding = {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  // KeyboardEvent.key lowercased; single letters or named keys (Escape, Enter).
  key: string;
};

const IS_MAC = /Mac|iPhone|iPad/.test(
  typeof navigator !== 'undefined' ? navigator.platform : '',
);

function parseShortcut(text: string | undefined): Binding | null {
  if (!text) return null;
  const parts = text
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return null;
  let ctrl = false;
  let shift = false;
  let alt = false;
  let meta = false;
  let key = '';
  for (const p of parts) {
    if (p === 'ctrl' || p === 'control') ctrl = true;
    else if (p === 'shift') shift = true;
    else if (p === 'alt' || p === 'option') alt = true;
    else if (p === 'meta' || p === 'cmd' || p === 'command' || p === 'win') {
      meta = true;
    } else if (p === 'mod') {
      if (IS_MAC) meta = true;
      else ctrl = true;
    } else {
      key = p;
    }
  }
  return key ? { ctrl, shift, alt, meta, key } : null;
}

function matchesBinding(e: KeyboardEvent, b: Binding): boolean {
  return (
    e.ctrlKey === b.ctrl &&
    e.shiftKey === b.shift &&
    e.altKey === b.alt &&
    e.metaKey === b.meta &&
    e.key.toLowerCase() === b.key
  );
}

// Cosmetic: render a platform-native shortcut label for the row's hint chip.
function formatShortcut(text: string): string {
  return text
    .split('+')
    .map((p) => {
      const trimmed = p.trim();
      const lower = trimmed.toLowerCase();
      if (lower === 'mod') return IS_MAC ? '⌘' : 'Ctrl';
      if (lower === 'cmd' || lower === 'meta' || lower === 'command') {
        return IS_MAC ? '⌘' : 'Win';
      }
      if (lower === 'ctrl' || lower === 'control') return 'Ctrl';
      if (lower === 'shift') return IS_MAC ? '⇧' : 'Shift';
      if (lower === 'alt' || lower === 'option') {
        return IS_MAC ? '⌥' : 'Alt';
      }
      if (trimmed.length === 1) return trimmed.toUpperCase();
      return trimmed[0].toUpperCase() + trimmed.slice(1).toLowerCase();
    })
    .join(IS_MAC ? '' : '+');
}

registerCommand({
  id: 'platform.toggle-light-mode',
  title: 'Toggle light mode',
  hint: 'Switch to / away from high contrast',
  shortcut: 'Mod+Shift+N',
  action: () => {
    const current = getSetting<boolean>('global', 'lightMode', false);
    setSetting('global', 'lightMode', !current);
  },
});

registerCommand({
  id: 'platform.toggle-nav-rail',
  title: 'Toggle navigation rail',
  hint: 'Toggle the left navigation bar',
  shortcut: 'Mod+Shift+B',
  action: () => {
    const current = getSetting<boolean>('global', 'showNavRail', true);
    setSetting('global', 'showNavRail', !current);
  },
});

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [commands, setCommands] = useState<PaletteCommand[]>(() =>
    getPaletteCommands(),
  );
  const [recents, setRecents] = usePersisted<RecentsByKind>(
    'its-command-palette',
    'recents',
    EMPTY_RECENTS,
  );
  const [location, setLocation] = useLocation();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const detached = useMemo(
    () => new URLSearchParams(window.location.search).get('detached') === '1',
    [],
  );

  // /_plugins gives both the tab mounts and per-plugin icon; the host routes
  // (/ and /settings) get their icons inlined below.
  useEffect(() => {
    if (detached) return;
    getPlugins().then((plugins) => {
      const real: Tab[] = [];
      for (const p of plugins) {
        if (!p.ui) continue;
        for (const mount of p.ui.mounts) {
          if (mount.target !== 'tab' || !mount.route || !mount.title) continue;
          real.push({
            route: mount.route,
            title: mount.title,
            pluginId: p.id,
            icon: p.ui.icon ?? null,
          });
        }
      }
      const host: Tab[] = [
        { route: '/', title: 'Home', pluginId: '_host', icon: 'home' },
        { route: '/settings', title: 'Settings', pluginId: '_host', icon: 'settings' },
      ];
      setTabs([...host, ...real]);
    });
  }, [detached]);

  // Track lazily-registered commands so they appear without reopening.
  useEffect(() => {
    return subscribePaletteCommands(() => setCommands(getPaletteCommands()));
  }, []);

  // Nav commands live in an effect, not at module load, because they need
  // wouter's setLocation (hook-only).
  useEffect(() => {
    if (detached) return;
    const unregHome = registerCommand({
      id: 'platform.go-home',
      title: 'Go to Home',
      hint: 'Jump to the platform dashboard',
      shortcut: 'Mod+Shift+H',
      // Already reachable as the Home host tab; hide the duplicate palette row.
      showInPalette: false,
      action: () => setLocation('/'),
    });
    const unregSettings = registerCommand({
      id: 'platform.open-settings',
      title: 'Open Settings',
      hint: 'Per-browser preferences and plugin settings',
      // Mod+, matches VS Code and avoids the Shift-punctuation `,`->`<` transform.
      shortcut: 'Mod+,',
      // Reachable as the Settings host tab; hide the redundant palette row.
      showInPalette: false,
      action: () => setLocation('/settings'),
    });
    return () => {
      unregHome();
      unregSettings();
    };
  }, [detached, setLocation]);

  // Mode derived from the query prefix; no separate state.
  const inCommandMode = query.startsWith('>');
  const effectiveQuery = (inCommandMode ? query.slice(1) : query)
    .trim()
    .toLowerCase();

  // Owning plugin of the current route, used to scope plugin commands to
  // their own view. _host for platform routes; sourceless commands always show.
  const currentPluginId = useMemo(
    () => tabs.find((t) => t.route === location)?.pluginId,
    [tabs, location],
  );

  const filtered: Row[] = useMemo(() => {
    const rows: Row[] = inCommandMode
      ? commands
          .filter((c) => c.showInPalette !== false)
          .filter((c) => c.source === undefined || c.source === currentPluginId)
          .map<Row>((c) => ({
            kind: 'command',
            command: c,
            source: sourceLabel(c.source),
          }))
      : tabs.map<Row>((t) => ({
          kind: 'tab',
          route: t.route,
          title: t.title,
          sub: t.route,
          source: sourceLabel(t.pluginId),
          pluginId: t.pluginId,
          icon: t.icon,
        }));

    // Score every row, drop misses, carry the score so the sort doesn't recompute.
    const scored = rows
      .map((row) => ({ row, score: scoreRow(effectiveQuery, row, recents) }))
      .filter((r) => r.score > 0);

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Stable secondary: title alpha so ties don't shuffle per render.
      const at = a.row.kind === 'tab' ? a.row.title : a.row.command.title;
      const bt = b.row.kind === 'tab' ? b.row.title : b.row.command.title;
      return at.localeCompare(bt);
    });
    return scored.map((r) => r.row);
  }, [tabs, commands, effectiveQuery, inCommandMode, currentPluginId, recents]);

  // Compiled bindings in a ref so the keydown listener reads the current set
  // without re-subscribing.
  const bindingsRef = useRef<{ binding: Binding; cmd: PaletteCommand }[]>([]);
  useEffect(() => {
    bindingsRef.current = commands.flatMap((cmd) => {
      const binding = parseShortcut(cmd.shortcut);
      return binding ? [{ binding, cmd }] : [];
    });
  }, [commands]);

  // Global hotkeys: Ctrl/Cmd+K (tabs), Ctrl/Cmd+P (commands), any command
  // shortcut, Esc to close. Also handles the synthetic `its:open-palette`
  // event so the mobile nav button can open it without a keyboard.
  useEffect(() => {
    if (detached) return;
    function onKey(e: KeyboardEvent) {
      // Don't intercept keys typed into editable fields; let inputs stay native.
      const tgt = e.target as HTMLElement | null;
      const editable =
        tgt &&
        (tgt.tagName === 'INPUT' ||
          tgt.tagName === 'TEXTAREA' ||
          tgt.isContentEditable);

      // Command shortcuts win over the palette's own toggle keys, so a plugin
      // can rebind Ctrl+K. Editable elements are exempt.
      if (!editable) {
        for (const { binding, cmd } of bindingsRef.current) {
          if (matchesBinding(e, binding)) {
            e.preventDefault();
            Promise.resolve()
              .then(() => cmd.action())
              .catch((err) => {
                // eslint-disable-next-line no-console
                console.error(`[palette] command "${cmd.id}" failed:`, err);
              });
            return;
          }
        }
      }

      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && (key === 'k' || key === 'p')) {
        e.preventDefault();
        setOpen((v) => !v);
        setQuery(key === 'p' ? '>' : '');
        setHighlight(0);
      } else if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
      }
    }
    function onOpen(e: Event) {
      const mode = (e as CustomEvent).detail?.mode ?? 'tabs';
      setOpen(true);
      setQuery(mode === 'commands' ? '>' : '');
      setHighlight(0);
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('its:open-palette', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('its:open-palette', onOpen);
    };
  }, [open, detached]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);
  useEffect(() => {
    if (highlight >= filtered.length) setHighlight(Math.max(0, filtered.length - 1));
  }, [filtered.length, highlight]);

  if (detached || !open) return null;

  function bumpRecent(row: Row): void {
    const kind: 'tabs' | 'commands' = row.kind === 'tab' ? 'tabs' : 'commands';
    const key = rowKey(row);
    const bucket = recents[kind] ?? {};
    const prior = bucket[key];
    const updated: RecentMap = {
      ...bucket,
      [key]: { count: (prior?.count ?? 0) + 1, ts: Date.now() },
    };
    // Cap the bucket to the most-recent N so localStorage doesn't grow unbounded.
    const trimmed = Object.fromEntries(
      Object.entries(updated)
        .sort((a, b) => b[1].ts - a[1].ts)
        .slice(0, RECENTS_CAP),
    );
    setRecents({ ...recents, [kind]: trimmed });
  }

  function activate(row: Row, popOut: boolean) {
    bumpRecent(row);
    if (row.kind === 'tab') {
      if (popOut) {
        window.open(
          `${row.route}?detached=1`,
          `its-${row.route}`,
          'width=900,height=600,menubar=no',
        );
      } else {
        setLocation(row.route);
      }
    } else {
      // Run in the background so a throwing command doesn't leave the palette open.
      Promise.resolve()
        .then(() => row.command.action())
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.error(`[palette] command "${row.command.id}" failed:`, err);
        });
    }
    setOpen(false);
  }

  function onInputKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(filtered.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = filtered[highlight];
      if (pick) activate(pick, e.shiftKey);
    }
  }

  const placeholder = inCommandMode
    ? 'Run command...'
    : 'Switch to... (type > for commands)';

  return (
    <div style={backdropStyle} onClick={() => setOpen(false)}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <div style={inputRowStyle}>
          {inCommandMode && <span style={modeBadgeStyle}>CMD</span>}
          <input
            ref={inputRef}
            type="text"
            placeholder={placeholder}
            value={query}
            onInput={(e) => {
              setQuery((e.target as HTMLInputElement).value);
              setHighlight(0);
            }}
            onKeyDown={onInputKey}
            style={inputStyle}
          />
        </div>
        <div style={listStyle}>
          {filtered.length === 0 ? (
            <div style={emptyStyle}>no matches</div>
          ) : (
            filtered.map((row, i) => (
              <PaletteRow
                key={row.kind === 'tab' ? row.route : row.command.id}
                row={row}
                active={i === highlight}
                onMouseEnter={() => setHighlight(i)}
                onClick={(e) => activate(row, e.shiftKey)}
              />
            ))
          )}
        </div>
        <div style={footerStyle}>
          <span>
            <kbd style={kbdStyle}>↵</kbd> {inCommandMode ? 'run' : 'open'}
          </span>
          {!inCommandMode && (
            <span>
              <kbd style={kbdStyle}>shift</kbd>
              <kbd style={kbdStyle}>↵</kbd> pop out
            </span>
          )}
          <span>
            <kbd style={kbdStyle}>&gt;</kbd> {inCommandMode ? 'tabs' : 'commands'}
          </span>
          <span>
            <kbd style={kbdStyle}>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}

function PaletteRow({
  row,
  active,
  onMouseEnter,
  onClick,
}: {
  row: Row;
  active: boolean;
  onMouseEnter: () => void;
  onClick: (e: MouseEvent) => void;
}) {
  const title = row.kind === 'tab' ? row.title : row.command.title;
  const sub =
    row.kind === 'tab' ? row.sub : row.command.hint ?? row.command.id;
  const shortcut =
    row.kind === 'command' && row.command.shortcut
      ? formatShortcut(row.command.shortcut)
      : undefined;
  return (
    <div
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      style={rowStyle(active)}
    >
      <span style={iconColStyle}>
        <RowGlyph row={row} />
      </span>
      <span style={rowTitleStyle}>{title}</span>
      <span style={rowSourceStyle}>{row.source}</span>
      {shortcut && <span style={rowShortcutStyle}>{shortcut}</span>}
      <span style={rowSubStyle}>{sub}</span>
    </div>
  );
}

// Tab rows reuse the manifest icon; command rows render a chevron.
function RowGlyph({ row }: { row: Row }) {
  if (row.kind === 'command') return <ChevronGlyph />;
  if (row.icon && hasIcon(row.icon)) return <Icon name={row.icon} />;
  // Monogram fallback for plugins without a declared icon.
  return (
    <span style={monogramStyle}>{(row.title[0] ?? '?').toUpperCase()}</span>
  );
}

function ChevronGlyph() {
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
      <path d="M8 6l6 6-6 6" />
    </svg>
  );
}

const backdropStyle = {
  position: 'fixed' as const,
  inset: 0,
  background: 'rgba(0, 0, 0, 0.55)',
  zIndex: 1001,
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  paddingTop: '12vh',
};
const panelStyle = {
  width: 'min(46rem, calc(100vw - 2rem))',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: '8px',
  boxShadow: '0 16px 48px rgba(0, 0, 0, 0.45)',
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column' as const,
};
const inputRowStyle = {
  display: 'flex',
  alignItems: 'center',
  borderBottom: '1px solid var(--border)',
  padding: '0 1rem',
  gap: '0.55rem',
};
const modeBadgeStyle = {
  display: 'inline-block',
  padding: '0.15rem 0.45rem',
  background: 'color-mix(in srgb, var(--accent) 18%, transparent)',
  color: 'var(--accent)',
  border: '1px solid var(--accent)',
  borderRadius: '3px',
  fontFamily: 'var(--mono)',
  fontSize: '0.65rem',
  letterSpacing: '0.1em',
  textTransform: 'uppercase' as const,
  flexShrink: 0,
};
const inputStyle = {
  flex: 1,
  padding: '0.85rem 0',
  background: 'transparent',
  border: 'none',
  color: 'var(--text)',
  fontFamily: 'var(--sans)',
  fontSize: '0.95rem',
  outline: 'none',
};
const listStyle = {
  maxHeight: '50vh',
  overflowY: 'auto' as const,
};
const rowStyle = (active: boolean) => ({
  display: 'flex',
  alignItems: 'center',
  gap: '0.7rem',
  padding: '0.55rem 1rem',
  cursor: 'pointer',
  background: active ? 'var(--surface-2)' : 'transparent',
  borderLeft: active ? '2px solid var(--accent)' : '2px solid transparent',
});
const iconColStyle = {
  width: '1.05rem',
  height: '1.05rem',
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--text-dim)',
};
const monogramStyle = {
  fontFamily: 'var(--mono)',
  fontSize: '0.72rem',
  fontWeight: 600,
  color: 'var(--text-muted)',
  letterSpacing: 0,
};
const rowTitleStyle = {
  color: 'var(--text)',
  fontSize: '0.9rem',
};
const rowSourceStyle = {
  color: 'var(--text-dim)',
  background: 'var(--surface-2)',
  border: '1px solid var(--border-dim)',
  borderRadius: '3px',
  padding: '0.05rem 0.4rem',
  fontFamily: 'var(--mono)',
  fontSize: '0.65rem',
  letterSpacing: '0.04em',
};
const rowShortcutStyle = {
  color: 'var(--text-dim)',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: '3px',
  padding: '0.05rem 0.4rem',
  fontFamily: 'var(--mono)',
  fontSize: '0.65rem',
  letterSpacing: '0.04em',
  whiteSpace: 'nowrap' as const,
};
const rowSubStyle = {
  color: 'var(--text-muted)',
  fontFamily: 'var(--mono)',
  fontSize: '0.75rem',
  marginLeft: 'auto',
  whiteSpace: 'nowrap' as const,
  overflow: 'hidden' as const,
  textOverflow: 'ellipsis' as const,
};
const emptyStyle = {
  padding: '0.8rem 1rem',
  color: 'var(--text-muted)',
  fontStyle: 'italic' as const,
  fontSize: '0.85rem',
};
const footerStyle = {
  display: 'flex',
  gap: '1.1rem',
  padding: '0.5rem 1rem',
  background: 'var(--surface-2)',
  borderTop: '1px solid var(--border)',
  color: 'var(--text-muted)',
  fontSize: '0.7rem',
};
const kbdStyle = {
  display: 'inline-block',
  padding: '0.05rem 0.35rem',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: '3px',
  fontFamily: 'var(--mono)',
  fontSize: '0.65rem',
  color: 'var(--text-dim)',
  marginRight: '0.2rem',
};
