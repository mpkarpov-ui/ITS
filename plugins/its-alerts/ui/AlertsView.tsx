// Full-page /alerts dashboard. Sources column (mute toggles write the
// cluster-wide Suppression global), active sticky list with clear/mute-key,
// and a persisted history ring buffer. Composer is reused from index.tsx via
// the `its:create-alert` event.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  getPlugins,
  globals,
  publish,
  subscribe,
  useGlobal,
  usePersisted,
  type PluginInfo,
} from '@its/sdk-react';
import type { Suppression } from '@its/contracts/its-alerts';
import { isSuppressed, ProgressBar } from './index';
import './AlertsView.css';

type AlertLevel = 'info' | 'warn' | 'error' | 'critical' | 'progress' | 'success';
const LEVELS: AlertLevel[] = ['info', 'warn', 'error', 'critical', 'progress', 'success'];
const HISTORY_CAP = 200;
// Source-count window for the Sources panel.
const RECENT_WINDOW_MS = 60 * 60 * 1000;
// Synthetic source for `its.operator.manual.alert`; shows as a Sources row
// even though no plugin declares it.
const OPERATOR_SOURCE = 'operator';

type AlertPayload = {
  level?: AlertLevel;
  title?: string;
  body?: string;
  key?: string | null;
  cleared?: boolean;
  progress?: number | null;
};

type HistoryEntry = {
  id: string;
  level: AlertLevel;
  title: string;
  body: string;
  source: string;
  subject: string;
  ts: number;
  key: string | null;
  // Set when a retraction lands; the entry stays in the log struck through so
  // the raised/cleared lifecycle stays visible.
  clearedAt: number | null;
  // Set when a keyed progress alert resolves to success.
  resolvedAt: number | null;
  // Determinate fraction for an in-flight progress entry; null = indeterminate.
  progress: number | null;
};

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sourceFromSubject(subject: string): string {
  const parts = subject.split('.');
  return parts[1] ?? '?';
}

// Stable fallback before the first KV read resolves, so filters skip null-checks.
const EMPTY_SUPP: Suppression = { sources: [], levels: [], keys: [] };

export function AlertsView() {
  const [supp, setSupp] = useGlobal(globals.itsAlerts.suppression);
  const suppression: Suppression = supp ?? EMPTY_SUPP;

  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  useEffect(() => {
    getPlugins().then(setPlugins).catch((e) => console.warn('[alerts] /_plugins', e));
  }, []);

  // Persisted ring buffer, fed independently of the toasts.
  const [history, setHistory] = usePersisted<HistoryEntry[]>(
    'its-alerts',
    'history',
    [],
  );

  // Not persisted: the bus is the source of truth, so on reload publishers
  // re-emit anything still pinned.
  const [active, setActive] = useState<Map<string, HistoryEntry>>(new Map());

  // "all" shows every entry (muted ones dimmed); "live" shows only entries that
  // pass the current suppression policy.
  const [historyTab, setHistoryTab] = useState<'all' | 'live'>('all');

  // Ref so the subscribe handler appends without re-subscribing (which would
  // drop intervening messages).
  const historyRef = useRef<HistoryEntry[]>(history);
  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  // Tick once per second so age columns update without re-rendering per message.
  const [tickedAt, setTickedAt] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setTickedAt(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    return subscribe('its.*.*.alert', (payload, subject) => {
      const a = payload as AlertPayload;
      if (!a) return;
      const source = sourceFromSubject(subject);
      const key = a.key || null;
      const ts = Date.now();

      // Sticky retraction: drop from `active`, mark the log entry cleared.
      if (key && a.cleared) {
        const activeKey = `${source}|${key}`;
        setActive((cur) => {
          if (!cur.has(activeKey)) return cur;
          const next = new Map(cur);
          next.delete(activeKey);
          return next;
        });
        const idx = historyRef.current.findIndex(
          (e) => e.source === source && e.key === key && !e.clearedAt && !e.resolvedAt,
        );
        if (idx >= 0) {
          const next = historyRef.current.slice();
          next[idx] = { ...next[idx], clearedAt: ts };
          historyRef.current = next;
          setHistory(next);
        }
        return;
      }

      if (typeof a.title !== 'string' || !a.title) return;
      const level: AlertLevel = a.level ?? 'info';
      const progress = typeof a.progress === 'number' ? a.progress : null;
      const terminal = level === 'success';
      const entry: HistoryEntry = {
        id: newId(),
        level,
        title: a.title,
        body: a.body ?? '',
        source,
        subject,
        ts,
        key,
        clearedAt: null,
        resolvedAt: terminal ? ts : null,
        progress,
      };

      if (key) {
        const activeKey = `${source}|${key}`;
        // Terminal success leaves the in-flight list; anything else stays pinned.
        setActive((cur) => {
          const next = new Map(cur);
          if (terminal) next.delete(activeKey);
          else next.set(activeKey, { ...entry, id: cur.get(activeKey)?.id ?? entry.id });
          return next;
        });
        // Update the open log entry in place so progress ticks don't flood it.
        const idx = historyRef.current.findIndex(
          (e) => e.source === source && e.key === key && !e.clearedAt && !e.resolvedAt,
        );
        if (idx >= 0) {
          const next = historyRef.current.slice();
          next[idx] = {
            ...next[idx],
            level,
            title: a.title,
            body: a.body ?? '',
            ts,
            progress,
            resolvedAt: terminal ? ts : null,
          };
          historyRef.current = next;
          setHistory(next);
          return;
        }
      }

      const next = [entry, ...historyRef.current].slice(0, HISTORY_CAP);
      historyRef.current = next;
      setHistory(next);
    });
    // Bare deps: subscribe must outlive history mutations; the ref carries the latest snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Plugins declaring publishes stream "alert", plus a synthetic operator row.
  const declaredSources = useMemo<string[]>(() => {
    const ids = plugins
      .filter((p) => p.publishes?.some((pub) => pub.stream === 'alert'))
      .map((p) => p.id);
    if (!ids.includes(OPERATOR_SOURCE)) ids.push(OPERATOR_SOURCE);
    return ids.sort();
  }, [plugins]);

  // 1h count by source from the persisted history (n <= 200).
  const recentCounts = useMemo<Record<string, number>>(() => {
    const cutoff = tickedAt - RECENT_WINDOW_MS;
    const counts: Record<string, number> = {};
    for (const e of history) {
      if (e.ts < cutoff) continue;
      counts[e.source] = (counts[e.source] ?? 0) + 1;
    }
    return counts;
  }, [history, tickedAt]);

  // Union declared sources with any seen in history/active (e.g. a removed
  // plugin's leftover entries), so the operator can still clear muted state.
  const allSources = useMemo<string[]>(() => {
    const set = new Set<string>(declaredSources);
    for (const e of history) set.add(e.source);
    for (const [, e] of active) set.add(e.source);
    return Array.from(set).sort();
  }, [declaredSources, history, active]);

  const activeList = useMemo<HistoryEntry[]>(() => {
    return Array.from(active.values()).sort((a, b) => b.ts - a.ts);
  }, [active]);

  // Keep full and non-suppressed lists separate so the tab counts stay accurate.
  const liveHistory = useMemo<HistoryEntry[]>(() => {
    return history.filter(
      (e) => !isSuppressed(suppression, e.source, e.level, e.key),
    );
  }, [history, suppression]);
  const visibleHistory = historyTab === 'all' ? history : liveHistory;

  function commitSupp(next: Suppression) {
    setSupp(next);
  }

  function toggleSource(source: string) {
    const has = suppression.sources.includes(source);
    commitSupp({
      ...suppression,
      sources: has
        ? suppression.sources.filter((s) => s !== source)
        : [...suppression.sources, source].sort(),
    });
  }
  function toggleLevel(level: AlertLevel) {
    const has = suppression.levels.includes(level);
    commitSupp({
      ...suppression,
      levels: has
        ? suppression.levels.filter((l) => l !== level)
        : [...suppression.levels, level],
    });
  }
  function toggleKey(source: string, key: string) {
    const compound = `${source}:${key}`;
    const has = suppression.keys.includes(compound);
    commitSupp({
      ...suppression,
      keys: has
        ? suppression.keys.filter((k) => k !== compound)
        : [...suppression.keys, compound].sort(),
    });
  }
  function resetSupp() {
    commitSupp({ sources: [], levels: [], keys: [] });
  }
  function clearHistory() {
    setHistory([]);
    historyRef.current = [];
  }

  function clearSticky(entry: HistoryEntry) {
    if (entry.key) publish(entry.subject, { key: entry.key, cleared: true });
  }

  const totalSuppressed =
    suppression.sources.length + suppression.levels.length + suppression.keys.length;

  return (
    <main class="alerts-view">
      <header class="alerts-header">
        <div class="alerts-title">ALERTS</div>
        <div class="alerts-header-actions">
          <button
            type="button"
            class="alerts-btn alerts-btn-primary"
            onClick={() =>
              window.dispatchEvent(new CustomEvent('its:create-alert'))
            }
          >
            <BellGlyph /> Create alert
          </button>
        </div>
      </header>

      <SuppressionStrip
        suppression={suppression}
        total={totalSuppressed}
        onReset={resetSupp}
      />

      <div class="alerts-grid">
        <section class="alerts-sources">
          <div class="alerts-panel-label">Sources</div>
          {allSources.length === 0 ? (
            <Empty>no alert sources discovered yet</Empty>
          ) : (
            allSources.map((source) => {
              const muted = suppression.sources.includes(source);
              const count = recentCounts[source] ?? 0;
              return (
                <div
                  key={source}
                  class={`alerts-source-row${muted ? ' alerts-source-muted' : ''}`}
                >
                  <span class={dotClass(count > 0 ? 'live' : 'silent')} />
                  <span class="alerts-source-name">
                    {source}
                    {source === OPERATOR_SOURCE && (
                      <span class="alerts-source-hint">manual composer</span>
                    )}
                  </span>
                  <span class="alerts-source-count">
                    {count > 0 ? `${count} in 1h` : '—'}
                  </span>
                  <button
                    type="button"
                    class={`alerts-mute-btn${muted ? ' alerts-mute-on' : ''}`}
                    onClick={() => toggleSource(source)}
                    title={
                      muted
                        ? `Unmute alerts from ${source}`
                        : `Mute all alerts from ${source}`
                    }
                  >
                    {muted ? 'muted' : 'mute'}
                  </button>
                </div>
              );
            })
          )}

          <div class="alerts-panel-label alerts-panel-label-sub">Mute levels</div>
          <div class="alerts-level-pills">
            {LEVELS.map((lv) => {
              const muted = suppression.levels.includes(lv);
              return (
                <button
                  key={lv}
                  type="button"
                  class={`alerts-level-pill alerts-level-pill-${lv}${
                    muted ? ' alerts-level-pill-on' : ''
                  }`}
                  onClick={() => toggleLevel(lv)}
                  title={
                    muted ? `Unmute all ${lv} alerts` : `Mute all ${lv} alerts`
                  }
                >
                  {lv}
                </button>
              );
            })}
          </div>
        </section>

        <section class="alerts-feed">
          <div class="alerts-panel-label alerts-feed-label">
            Active sticky ({activeList.length})
          </div>
          {activeList.length === 0 ? (
            <Empty>no sticky alerts pinned</Empty>
          ) : (
            <div class="alerts-active-list">
              {activeList.map((entry) => {
                const compound = `${entry.source}:${entry.key}`;
                const keyMuted = suppression.keys.includes(compound);
                const sourceMuted = suppression.sources.includes(entry.source);
                const levelMuted = suppression.levels.includes(entry.level);
                const muted = keyMuted || sourceMuted || levelMuted;
                return (
                  <div
                    key={entry.id}
                    class={`alerts-active-row alerts-row-${entry.level}${
                      muted ? ' alerts-row-muted' : ''
                    }`}
                  >
                    <span class="alerts-row-icon">
                      <LevelIcon level={entry.level} />
                    </span>
                    <div class="alerts-row-main">
                      <div class="alerts-row-title">{entry.title}</div>
                      {entry.body && (
                        <div class="alerts-row-body">{entry.body}</div>
                      )}
                      {entry.level === 'progress' && (
                        <ProgressBar value={entry.progress} />
                      )}
                      <div class="alerts-row-meta">
                        {entry.source} · {fmtTime(entry.ts)}
                        {entry.key && (
                          <>
                            {' · '}
                            <code class="alerts-row-key">key={entry.key}</code>
                          </>
                        )}
                        {muted && (
                          <span class="alerts-row-badge">
                            {keyMuted
                              ? 'key muted'
                              : sourceMuted
                              ? 'source muted'
                              : 'level muted'}
                          </span>
                        )}
                      </div>
                    </div>
                    <div class="alerts-row-actions">
                      <button
                        type="button"
                        class="alerts-row-btn"
                        onClick={() => clearSticky(entry)}
                        title="Publish a cleared retraction to drop this sticky everywhere"
                      >
                        clear
                      </button>
                      {entry.key && (
                        <button
                          type="button"
                          class={`alerts-row-btn${keyMuted ? ' alerts-row-btn-on' : ''}`}
                          onClick={() => toggleKey(entry.source, entry.key!)}
                          title={
                            keyMuted
                              ? `Unmute this sticky key (${compound})`
                              : `Mute just this sticky key (${compound})`
                          }
                        >
                          {keyMuted ? 'key muted' : 'mute key'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div class="alerts-history-header">
            <div class="alerts-history-tabs" role="tablist">
              <span class="alerts-panel-label alerts-history-tabs-label">
                Recent history
              </span>
              <button
                type="button"
                role="tab"
                aria-selected={historyTab === 'all'}
                class={`alerts-history-tab${
                  historyTab === 'all' ? ' alerts-history-tab-active' : ''
                }`}
                onClick={() => setHistoryTab('all')}
              >
                all <span class="alerts-history-tab-count">{history.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={historyTab === 'live'}
                class={`alerts-history-tab${
                  historyTab === 'live' ? ' alerts-history-tab-active' : ''
                }`}
                onClick={() => setHistoryTab('live')}
                title="Only entries that would pass the current mute policy"
              >
                non-suppressed{' '}
                <span class="alerts-history-tab-count">{liveHistory.length}</span>
              </button>
            </div>
            {history.length > 0 && (
              <button
                type="button"
                class="alerts-clear-history"
                onClick={clearHistory}
                title="Clear the persisted history log (does not affect active sticky alerts)"
              >
                clear log
              </button>
            )}
          </div>
          {visibleHistory.length === 0 ? (
            <Empty>
              {history.length === 0
                ? 'no alerts logged yet'
                : 'every logged alert is currently suppressed'}
            </Empty>
          ) : (
            <div class="alerts-history-list">
              {visibleHistory.map((entry) => {
                const muted = isSuppressed(
                  suppression,
                  entry.source,
                  entry.level,
                  entry.key,
                );
                return (
                  <div
                    key={entry.id}
                    class={`alerts-history-row${
                      entry.clearedAt ? ' alerts-history-cleared' : ''
                    }${entry.resolvedAt ? ' alerts-history-resolved' : ''}${
                      muted ? ' alerts-history-muted' : ''
                    }`}
                  >
                    <span class="alerts-history-time">{fmtTime(entry.ts)}</span>
                    <span class={`alerts-history-icon alerts-level-${entry.level}`}>
                      <LevelIcon level={entry.level} />
                    </span>
                    <span class="alerts-history-title">{entry.title}</span>
                    <span class="alerts-history-source">{entry.source}</span>
                    {entry.clearedAt && (
                      <span class="alerts-history-clearmark">
                        cleared {fmtTime(entry.clearedAt)}
                      </span>
                    )}
                    {entry.resolvedAt && !entry.clearedAt && (
                      <span class="alerts-history-resolvemark">
                        done {fmtTime(entry.resolvedAt)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function SuppressionStrip({
  suppression,
  total,
  onReset,
}: {
  suppression: Suppression;
  total: number;
  onReset: () => void;
}) {
  if (total === 0) return null;
  const parts: string[] = [];
  if (suppression.sources.length > 0) {
    parts.push(`${suppression.sources.length} source${suppression.sources.length === 1 ? '' : 's'}`);
  }
  if (suppression.levels.length > 0) {
    parts.push(suppression.levels.join(', '));
  }
  if (suppression.keys.length > 0) {
    parts.push(`${suppression.keys.length} key${suppression.keys.length === 1 ? '' : 's'}`);
  }
  return (
    <div class="alerts-suppress-strip">
      <span class="alerts-suppress-label">Suppressed</span>
      <span class="alerts-suppress-summary">{parts.join(' · ')}</span>
      <button type="button" class="alerts-suppress-reset" onClick={onReset}>
        reset
      </button>
    </div>
  );
}

function Empty({ children }: { children: any }) {
  return <div class="alerts-empty">{children}</div>;
}

function dotClass(status: 'live' | 'silent'): string {
  return `alerts-source-dot alerts-source-dot-${status}`;
}

function fmtTime(t: number): string {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function BellGlyph() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
}

// Same per-level glyph as the toasts and Home.
function LevelIcon({ level }: { level: AlertLevel }) {
  const stroke = {
    width: 14,
    height: 14,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.6,
    'stroke-linecap': 'round' as const,
    'stroke-linejoin': 'round' as const,
  };
  switch (level) {
    case 'info':
      return (
        <svg {...stroke}>
          <circle cx="8" cy="8" r="6.5" />
          <line x1="8" y1="7.2" x2="8" y2="11.8" />
          <circle cx="8" cy="4.6" r="0.5" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'warn':
      return (
        <svg {...stroke}>
          <path d="M8 1.8 L14.6 13.5 L1.4 13.5 Z" />
          <line x1="8" y1="6.2" x2="8" y2="9.8" />
          <circle cx="8" cy="11.6" r="0.5" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'error':
      return (
        <svg {...stroke}>
          <circle cx="8" cy="8" r="6.5" />
          <line x1="5.2" y1="5.2" x2="10.8" y2="10.8" />
          <line x1="10.8" y1="5.2" x2="5.2" y2="10.8" />
        </svg>
      );
    case 'critical':
      return (
        <svg
          width={14}
          height={14}
          viewBox="0 0 16 16"
          fill="currentColor"
          stroke="none"
        >
          <path d="M4.85 1.4 L11.15 1.4 L14.6 4.85 L14.6 11.15 L11.15 14.6 L4.85 14.6 L1.4 11.15 L1.4 4.85 Z" />
          <rect x="7.3" y="4.5" width="1.4" height="5.2" rx="0.45" fill="var(--bg)" />
          <circle cx="8" cy="11.55" r="0.85" fill="var(--bg)" />
        </svg>
      );
    case 'progress':
      return (
        <svg {...stroke}>
          <path d="M14 8 A6 6 0 1 1 8 2" />
        </svg>
      );
    case 'success':
      return (
        <svg {...stroke}>
          <circle cx="8" cy="8" r="6.5" />
          <path d="M5 8.2 L7.2 10.4 L11 5.8" />
        </svg>
      );
  }
}
