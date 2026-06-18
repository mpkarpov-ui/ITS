import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  getMeta,
  getPlugins,
  getStats,
  globals,
  MountPoint,
  publish,
  subscribe,
  useCachedMap,
  useGlobal,
} from '@its/sdk-react';
import type {
  PlatformMeta,
  PlatformStats,
  PluginInfo,
} from '@its/sdk-react';
import type { Suppression } from '@its/contracts/its-alerts';
import './Home.css';

// Platform status dashboard (navigation lives in the nav rail). Grid panels:
// bus (headline metrics + per-source stream liveness from declared `publishes`
// vs actual bus traffic), shells, plugins, alerts, recent activity.

type Shell = {
  station: string;
  instance_key: string;
  ts_ms: number;
  uptime_s: number;
  allow_exec: boolean;
  intakes: { instance_id: string; plugin: string }[];
};

type RecentMsg = { ts: number; subject: string; preview: string };

// Source-liveness model. Each declared stream (from the manifest's `publishes`)
// gets a live / stale / silent verdict matched against concrete bus subjects
// (its.<plugin>.<instance>.<path...>).
type StreamLiveness = 'live' | 'stale' | 'silent';
type DeclaredStream = { stream: string; path: string };
type DeclaredSource = { plugin: string; streams: DeclaredStream[] };
type SourceStream = { stream: string; status: StreamLiveness; rate: number };
type SourceRow = { plugin: string; streams: SourceStream[]; totalRate: number };

// Mirrors the its-alerts toast model (subject its.<plugin>.<instance>.alert,
// payload {level,title,body,key,cleared}) but keeps a persistent log. Sticky
// alerts (key set) dedupe by (source,key) and clear on a `cleared` message.
type AlertLevel = 'info' | 'warn' | 'error' | 'critical';
type AlertEvent = {
  id: string;
  level: AlertLevel;
  title: string;
  source: string;
  subject: string; // concrete subject, for publishing a cleared retraction
  ts: number;
  key: string | null;
};

const RATE_SAMPLE_MS = 1000;
const RECENT_CAP = 50;
const ALERTS_CAP = 30;
// live = produced in the last LIVE_SAMPLES seconds; stale = within the window
// but not recently; silent = declared but nothing in the window.
const LIVE_SAMPLES = 3;
// Shells publish at 1Hz: 3s = three missed heartbeats (stale), 10s = dropped.
const SHELL_STALE_MS = 3_000;
const SHELL_DROPPED_MS = 10_000;
// Bus rate stays snappy (5s); the source breakdown smooths over 30s so subjects
// don't blink in and out of the top-N near the threshold.
const BUS_RATE_WINDOW_S = 5;
const TOP_SUBJECTS_WINDOW_S = 30;

export function Home() {
  const [meta, setMeta] = useState<PlatformMeta | null>(null);
  const [stats, setStats] = useState<PlatformStats | null>(null);
  // Local tick for the wall clock without flooding /_stats. Uptime is the last
  // server-authoritative stat plus a client-side delta since that poll.
  const [tickedAt, setTickedAt] = useState(Date.now());
  const statsAnchorRef = useRef<{ ms: number; uptime_s: number } | null>(null);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [pluginErr, setPluginErr] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentMsg[]>([]);
  const [alerts, setAlerts] = useState<AlertEvent[]>([]);
  const [busRate, setBusRate] = useState(0);
  const [busTotal, setBusTotal] = useState(0);
  const [sources, setSources] = useState<SourceRow[]>([]);
  // Declared sources from the manifests; in a ref so the sample tick reads
  // them without re-subscribing.
  const declaredSourcesRef = useRef<DeclaredSource[]>([]);

  useEffect(() => {
    getMeta().then(setMeta).catch((e) => console.warn('[home] /_meta', e));
    getPlugins().then(setPlugins).catch((e) => setPluginErr(String(e)));
  }, []);

  // Only plugins declaring `publishes` are sources.
  useEffect(() => {
    declaredSourcesRef.current = plugins.flatMap((p) =>
      p.publishes && p.publishes.length > 0
        ? [
            {
              plugin: p.id,
              streams: p.publishes.map((pub) => ({
                stream: pub.stream,
                // Subject tail after instance_key. Keep the full template
                // (placeholders included) so matchesPath can compare segment by
                // segment; the path may be multi-segment or start with a
                // placeholder ("{midas_id}.tlm").
                path: pub.path ?? pub.stream,
              })),
            },
          ]
        : [],
    );
  }, [plugins]);

  // /_stats poll: server-authoritative cpu/mem/uptime.
  useEffect(() => {
    let cancelled = false;
    const pull = () => {
      getStats()
        .then((s) => {
          if (cancelled) return;
          setStats(s);
          statsAnchorRef.current = { ms: Date.now(), uptime_s: s.uptime_s };
        })
        .catch((e) => console.warn('[home] /_stats', e));
    };
    pull();
    const id = setInterval(pull, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Live shell map via the shared cache (instant warm-start).
  const shellsMap = useCachedMap('its.its-shell.*.heartbeat');
  const shells = useMemo<Record<string, Shell>>(() => {
    const out: Record<string, Shell> = {};
    for (const [, entry] of shellsMap) {
      const h = entry.value as Shell;
      if (h.instance_key) out[h.instance_key] = h;
    }
    return out;
  }, [shellsMap]);

  // One bus subscription, three uses: rate counters (ref, sampled by the 1s
  // interval), per-subject counts for the source breakdown, and the recent
  // ticker (state, per-message). Per-message setRecent is fine; Preact batches
  // and the list caps at RECENT_CAP rows.
  const countRef = useRef({
    total: 0,
    sinceLastSample: 0,
    perSubject: new Map<string, number>(),
  });
  // Rolling windows so the rate and breakdown don't flicker.
  const busRateRingRef = useRef<number[]>([]);
  const perSubjectRingRef = useRef<Map<string, number>[]>([]);
  useEffect(() => {
    return subscribe('its.>', (payload, concreteSubject) => {
      const c = countRef.current;
      c.total += 1;
      c.sinceLastSample += 1;
      c.perSubject.set(concreteSubject, (c.perSubject.get(concreteSubject) ?? 0) + 1);

      setRecent((cur) => {
        const next = [
          { ts: Date.now(), subject: concreteSubject, preview: previewOf(payload) },
          ...cur,
        ];
        if (next.length > RECENT_CAP) next.length = RECENT_CAP;
        return next;
      });
    });
  }, []);

  // Cluster-wide mute policy, mirroring AlertToasts. Cleared retractions always
  // pass through so a sticky raised before muting tears down cleanly.
  const [suppression] = useGlobal(globals.itsAlerts.suppression);
  const suppressionRef = useRef<Suppression | null>(suppression);
  useEffect(() => {
    suppressionRef.current = suppression;
  }, [suppression]);

  // Alerts log over its.*.*.alert. Same stream the toast plugin consumes;
  // subscriptions are shared at the bridge so this adds no extra NATS traffic.
  useEffect(() => {
    return subscribe('its.*.*.alert', (payload, subject) => {
      const a = payload as {
        level?: AlertLevel;
        title?: string;
        key?: string | null;
        cleared?: boolean;
      };
      if (!a) return;
      const source = subject.split('.')[1] ?? '?';
      const key = a.key || null;
      if (key && a.cleared) {
        setAlerts((cur) =>
          cur.filter((e) => !(e.source === source && e.key === key)),
        );
        return;
      }
      if (typeof a.title !== 'string' || !a.title) return;
      const level: AlertLevel = a.level ?? 'info';
      // Same predicate as AlertToasts' isSuppressed so both hide the same alerts.
      const supp = suppressionRef.current;
      if (supp) {
        if (supp.sources.includes(source)) return;
        if (supp.levels.includes(level)) return;
        if (key && supp.keys.includes(`${source}:${key}`)) return;
      }
      const ev: AlertEvent = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        level,
        title: a.title,
        source,
        subject,
        ts: Date.now(),
        key,
      };
      setAlerts((cur) => {
        if (key) {
          const idx = cur.findIndex(
            (e) => e.source === source && e.key === key,
          );
          if (idx >= 0) {
            const copy = cur.slice();
            copy[idx] = ev;
            return copy;
          }
        }
        return [ev, ...cur].slice(0, ALERTS_CAP);
      });
    });
  }, []);

  // Sample tick: bus rate + sources + clock.
  useEffect(() => {
    const id = setInterval(() => {
      const c = countRef.current;

      // Bus rate: rolling N-sample average (msg/s over N seconds).
      busRateRingRef.current.push(c.sinceLastSample);
      if (busRateRingRef.current.length > BUS_RATE_WINDOW_S) {
        busRateRingRef.current.shift();
      }
      const ring = busRateRingRef.current;
      const avgRate = ring.reduce((a, b) => a + b, 0) / ring.length;
      setBusRate(Math.round(avgRate));
      setBusTotal(c.total);
      c.sinceLastSample = 0;

      // Per-source liveness: snapshot per-subject counts into the rolling
      // window, then aggregate below for each declared stream's verdict + rate.
      perSubjectRingRef.current.push(new Map(c.perSubject));
      if (perSubjectRingRef.current.length > TOP_SUBJECTS_WINDOW_S) {
        perSubjectRingRef.current.shift();
      }
      c.perSubject.clear();

      // Per (plugin, subject-tail) counts over the full window and the recent
      // samples. The tail is everything after instance_key, matched against the
      // declared path template below.
      const subjectRing = perSubjectRingRef.current;
      const recentStart = Math.max(0, subjectRing.length - LIVE_SAMPLES);
      type TailCounts = { plugin: string; tail: string; window: number; recent: number };
      const tails = new Map<string, TailCounts>();
      subjectRing.forEach((snap, idx) => {
        for (const [subject, count] of snap) {
          // its.<plugin>.<instance_key>.<tail...>
          const parts = subject.split('.');
          if (parts.length < 4 || parts[0] !== 'its') continue;
          const plugin = parts[1];
          const tail = parts.slice(3).join('.');
          const key = `${plugin}|${tail}`;
          let tc = tails.get(key);
          if (!tc) {
            tc = { plugin, tail, window: 0, recent: 0 };
            tails.set(key, tc);
          }
          tc.window += count;
          if (idx >= recentStart) tc.recent += count;
        }
      });
      const windowS = subjectRing.length || 1;
      setSources(
        declaredSourcesRef.current.map((src) => {
          const streams = src.streams.map<SourceStream>((s) => {
            // Sum every concrete subject from this plugin whose tail matches the
            // declared path template (placeholders match any single segment).
            let w = 0;
            let r = 0;
            for (const tc of tails.values()) {
              if (tc.plugin !== src.plugin) continue;
              if (!matchesPath(tc.tail, s.path)) continue;
              w += tc.window;
              r += tc.recent;
            }
            const status: StreamLiveness =
              r > 0 ? 'live' : w > 0 ? 'stale' : 'silent';
            return { stream: s.stream, status, rate: w / windowS };
          });
          const totalRate = streams.reduce((acc, s) => acc + s.rate, 0);
          return { plugin: src.plugin, streams, totalRate };
        }),
      );

      setTickedAt(Date.now());
    }, RATE_SAMPLE_MS);
    return () => clearInterval(id);
  }, []);

  // live (fresh heartbeat) / stale (a few missed) / dropped (long silence).
  // Live shells are what the Bus panel counts.
  type ShellRow = { shell: Shell; status: 'live' | 'stale' | 'dropped'; ageMs: number };
  const classifiedShells = useMemo<ShellRow[]>(() => {
    const rows: ShellRow[] = Object.values(shells).map((shell) => {
      const ageMs = tickedAt - shell.ts_ms;
      const status =
        ageMs < SHELL_STALE_MS ? 'live' : ageMs < SHELL_DROPPED_MS ? 'stale' : 'dropped';
      return { shell, status, ageMs };
    });
    // Live, then stale, then dropped; within a group by name.
    const order = { live: 0, stale: 1, dropped: 2 } as const;
    rows.sort(
      (a, b) =>
        order[a.status] - order[b.status] ||
        a.shell.instance_key.localeCompare(b.shell.instance_key),
    );
    return rows;
  }, [shells, tickedAt]);

  const liveShells = classifiedShells.filter((r) => r.status === 'live');

  // Uptime = last server anchor + client delta (survives clock drift / sleep).
  // Falls back to /_meta's started_at_ms until /_stats first responds.
  const uptimeS = statsAnchorRef.current
    ? statsAnchorRef.current.uptime_s +
      Math.max(0, (tickedAt - statsAnchorRef.current.ms) / 1000)
    : meta
    ? Math.max(0, (tickedAt - meta.started_at_ms) / 1000)
    : 0;

  // Busiest source sets the bar scale (relative volume per source).
  const maxSourceRate =
    sources.reduce((m, s) => Math.max(m, s.totalRate), 0) || 1;

  return (
    <main style={pageStyle}>
      <header style={headerStyle}>
        <div style={brandRowStyle}>
          <span style={logoStyle}>ITS</span>
          <span style={versionStyle}>{meta ? `v${meta.version}` : '...'}</span>
          <span style={mottoStyle}>not rocket science</span>
        </div>
        <div style={metricsRowStyle}>
          <Metric label="time" value={fmtClock(tickedAt)} />
          <Metric label="uptime" value={fmtUptime(uptimeS)} />
          <Metric
            label="cpu"
            value={stats ? `${stats.cpu_percent.toFixed(1)}%` : '...'}
          />
          <Metric
            label="mem"
            value={stats ? `${stats.mem_mb.toFixed(0)} MB` : '...'}
          />
        </div>
      </header>

      <div style={gridStyle}>
        <Panel label="Bus" style={{ gridArea: 'bus' }}>
          <div style={busRowStyle}>
            <Stat value={`${busRate}`} unit="msg/s" />
            <Stat value={fmtCount(busTotal)} unit="total" small />
            <Stat
              value={`${liveShells.length}`}
              unit={liveShells.length === 1 ? 'shell' : 'shells'}
              small
            />
          </div>
          <div style={subjectsHeaderStyle}>
            sources · last {TOP_SUBJECTS_WINDOW_S}s
          </div>
          {sources.length === 0 ? (
            <Empty>no sources declared</Empty>
          ) : (
            <div style={sourcesListStyle}>
              {sources.map((src) => (
                <div key={src.plugin} style={sourceRowStyle}>
                  <span style={sourceNameStyle}>{src.plugin}</span>
                  <span style={sourceDotsStyle}>
                    {src.streams.map((s) => (
                      <span
                        key={s.stream}
                        style={streamDot(s.status)}
                        title={`${s.stream} · ${s.status}${
                          s.rate > 0 ? ` · ${fmtRate(s.rate)}/s` : ''
                        }`}
                      />
                    ))}
                  </span>
                  <div style={sourceBarTrackStyle}>
                    <div
                      style={{
                        ...sourceBarFillStyle,
                        width: `${(src.totalRate / maxSourceRate) * 100}%`,
                      }}
                    />
                  </div>
                  <span style={sourceRateStyle}>
                    {src.totalRate > 0 ? `${fmtRate(src.totalRate)}/s` : '—'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel label="Shells" style={{ gridArea: 'shells' }}>
          {classifiedShells.length === 0 ? (
            <Empty>no shells reporting</Empty>
          ) : (
            classifiedShells.map((row) => {
              const { shell: s, status, ageMs } = row;
              const dotColor =
                status === 'live'
                  ? 'var(--status-live)'
                  : status === 'stale'
                  ? 'var(--status-stale)'
                  : 'var(--status-error)';
              const opacity = status === 'dropped' ? 0.7 : 1;
              return (
                <div key={s.instance_key} style={{ ...rowStyle, opacity }}>
                  <span style={dot(dotColor)} />
                  <span style={monoStyle}>{s.station}</span>
                  <span style={metaStyle}>
                    {status === 'live' && (
                      <>
                        {s.intakes.length} intake
                        {s.intakes.length === 1 ? '' : 's'}
                        {s.allow_exec && ' · exec'}
                        {' · '}up {fmtUptime(s.uptime_s)}
                      </>
                    )}
                    {status === 'stale' && (
                      <>stale · {Math.round(ageMs / 1000)}s since heartbeat</>
                    )}
                    {status === 'dropped' && (
                      <>dropped · last seen {fmtAgo(ageMs / 1000)}</>
                    )}
                  </span>
                </div>
              );
            })
          )}
        </Panel>

        <Panel
          label={`Plugins (${plugins.length})`}
          style={{ gridArea: 'plugins' }}
        >
          {pluginErr && <Empty>{pluginErr}</Empty>}
          {plugins.map((p) => (
            <div key={p.id} style={rowStyle}>
              <span style={dot(p.ui ? 'var(--accent)' : 'var(--text-muted)')} />
              <span style={monoStyle}>{p.id}</span>
              <span style={metaStyle}>
                v{p.version}
                {(p as { runtime_kind?: string }).runtime_kind &&
                  ` · ${(p as { runtime_kind?: string }).runtime_kind}`}
                {p.ui && ' · ui'}
              </span>
            </div>
          ))}
        </Panel>

        <Panel
          label="Alerts"
          style={{
            gridArea: 'alerts',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}
          action={
            // No manual-alert button on a read-only repeater host; the bridge
            // would reject the publish.
            meta?.readonly ? undefined : (
              <button
                type="button"
                class="home-icon-btn"
                title="Create alert"
                aria-label="Create alert"
                onClick={() =>
                  window.dispatchEvent(new CustomEvent('its:create-alert'))
                }
              >
                <BellIcon />
              </button>
            )
          }
        >
          <div style={alertsListStyle}>
            {alerts.length === 0 ? (
              <Empty>no alerts</Empty>
            ) : (
              alerts.map((a) => (
                <div
                  key={a.id}
                  class={`home-alert home-alert-${a.level}`}
                  style={alertRowStyle}
                >
                  <span style={alertIconStyle(a.level)}>
                    <LevelIcon level={a.level} />
                  </span>
                  <span style={alertTitleStyle}>{a.title}</span>
                  <span style={alertMetaStyle}>
                    {a.source} · {fmtTime(a.ts)}
                  </span>
                  <button
                    type="button"
                    class="home-alert-clear"
                    title="Clear alert"
                    aria-label="Clear alert"
                    onClick={() => {
                      // Keyed (sticky) alerts clear globally via a cleared
                      // retraction on their own subject; transient ones only
                      // dismiss from this local log.
                      if (a.key) {
                        publish(a.subject, { key: a.key, cleared: true });
                      }
                      setAlerts((cur) => cur.filter((e) => e.id !== a.id));
                    }}
                  >
                    <CloseIcon />
                  </button>
                </div>
              ))
            )}
          </div>
        </Panel>

        <Panel
          label="Recent activity"
          style={{
            gridArea: 'recent',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}
        >
          <div style={recentListStyle}>
            {recent.length === 0 ? (
              <Empty>no bus traffic yet</Empty>
            ) : (
              recent.slice(0, 30).map((m, i) => (
                <div key={i} style={recentRowStyle}>
                  <span style={recentTimeStyle}>{fmtTime(m.ts)}</span>
                  <span style={recentSubjectStyle}>{shortSubject(m.subject)}</span>
                  <span style={recentBodyStyle}>{m.preview}</span>
                </div>
              ))
            )}
          </div>
        </Panel>
      </div>

      <div style={widgetSlotStyle}>
        <MountPoint target="home.widget" />
      </div>
    </main>
  );
}

const pageStyle = {
  padding: '1.2rem 1.6rem 2rem',
  width: '100%',
  // Definite height (not min-height) caps the grid to the viewport so the
  // event-log panels scroll internally instead of growing the page.
  height: '100vh',
  boxSizing: 'border-box' as const,
  display: 'flex',
  flexDirection: 'column' as const,
};
const headerStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: '1.2rem',
  paddingBottom: '0.9rem',
  borderBottom: '1px solid var(--border)',
  gap: '1rem',
  flexWrap: 'wrap' as const,
};
const brandRowStyle = {
  display: 'flex',
  alignItems: 'baseline',
  gap: '0.7rem',
};
const logoStyle = {
  fontFamily: 'var(--mono)',
  fontSize: '1.6rem',
  fontWeight: 700,
  letterSpacing: '0.2em',
  color: 'var(--text)',
};
const versionStyle = {
  fontFamily: 'var(--mono)',
  fontSize: '0.8rem',
  color: 'var(--accent)',
  letterSpacing: '0.05em',
};
const mottoStyle = {
  color: 'var(--text-muted)',
  fontSize: '0.7rem',
  letterSpacing: '0.22em',
  textTransform: 'uppercase' as const,
  paddingLeft: '0.9rem',
  marginLeft: '0.3rem',
  borderLeft: '1px solid var(--border)',
};
const metricsRowStyle = {
  display: 'flex',
  gap: '1.4rem',
  alignItems: 'baseline',
};
const gridStyle = {
  display: 'grid',
  gap: '0.7rem',
  gridTemplateColumns: '1fr 1fr 1fr',
  // Top row status, bottom row the two event logs taking remaining height.
  // minmax(0, 1fr) (not bare 1fr) lets the row shrink below its content so the
  // log panels scroll internally instead of growing the page.
  gridTemplateRows: 'auto minmax(0, 1fr)',
  flex: '1 1 auto',
  minHeight: 0,
  gridTemplateAreas: `
    "bus    shells plugins"
    "alerts recent recent"
  `,
};

const panelStyle = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: '6px',
  padding: '0.7rem 0.9rem',
  minWidth: 0,
};
// Panel title + optional action. minHeight keeps panels with and without an
// action aligned.
const panelLabelRowStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.5rem',
  marginBottom: '0.5rem',
  minHeight: '1.5rem',
};
const panelLabelStyle = {
  fontSize: '0.65rem',
  letterSpacing: '0.12em',
  textTransform: 'uppercase' as const,
  color: 'var(--text-muted)',
};

const rowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  padding: '0.3rem 0',
  fontSize: '0.85rem',
  borderBottom: '1px solid var(--border-dim)',
};
const monoStyle = { fontFamily: 'var(--mono)', color: 'var(--text)' };
const metaStyle = {
  color: 'var(--text-muted)',
  fontSize: '0.72rem',
  marginLeft: 'auto',
};
const dot = (color: string) => ({
  width: '0.5rem',
  height: '0.5rem',
  borderRadius: '50%',
  background: color,
  display: 'inline-block',
  flexShrink: 0,
});

// Bus / Sources panel
const busRowStyle = {
  display: 'flex',
  alignItems: 'baseline',
  gap: '0.9rem',
  marginBottom: '0.7rem',
};
const subjectsHeaderStyle = {
  fontSize: '0.62rem',
  letterSpacing: '0.08em',
  color: 'var(--text-muted)',
  textTransform: 'uppercase' as const,
  marginBottom: '0.3rem',
};
const sourcesListStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: '0.1rem',
  maxHeight: '26rem',
  overflowY: 'auto' as const,
};
const sourceRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  padding: '0.28rem 0',
  fontSize: '0.78rem',
  borderBottom: '1px solid var(--border-dim)',
};
const sourceNameStyle = {
  fontFamily: 'var(--mono)',
  color: 'var(--text)',
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap' as const,
};
const sourceDotsStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.32rem',
  flexShrink: 0,
};
const sourceBarTrackStyle = {
  width: '3rem',
  height: '4px',
  background: 'var(--border-dim)',
  borderRadius: '2px',
  overflow: 'hidden',
  flexShrink: 0,
};
const sourceBarFillStyle = {
  height: '100%',
  background: 'var(--accent)',
  transition: 'width 300ms ease',
};
const sourceRateStyle = {
  fontFamily: 'var(--mono)',
  fontSize: '0.7rem',
  color: 'var(--text-muted)',
  width: '3rem',
  textAlign: 'right' as const,
  flexShrink: 0,
};
function streamDot(status: StreamLiveness) {
  const base = {
    width: '0.62rem',
    height: '0.62rem',
    borderRadius: '50%',
    display: 'inline-block',
    flexShrink: 0,
    boxSizing: 'border-box' as const,
  };
  if (status === 'live') return { ...base, background: 'var(--status-live)' };
  if (status === 'stale') return { ...base, background: 'var(--status-stale)' };
  // silent: hollow dim ring.
  return {
    ...base,
    background: 'transparent',
    border: '1.5px solid var(--text-muted)',
  };
}

// Recent activity panel
const recentListStyle = {
  fontFamily: 'var(--mono)',
  fontSize: '0.72rem',
  flex: '1 1 auto',
  minHeight: 0,
  overflowY: 'auto' as const,
};

// Alerts panel
const alertsListStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: '0.2rem',
  flex: '1 1 auto',
  minHeight: 0,
  overflowY: 'auto' as const,
};
// Layout only; the per-level background / flash comes from the
// home-alert-<level> classes in Home.css.
const alertRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  padding: '0.32rem 0.4rem 0.32rem 0.5rem',
};
const alertTitleStyle = {
  flex: '1 1 auto',
  minWidth: 0,
  fontSize: '0.8rem',
  color: 'var(--text)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap' as const,
};
const alertMetaStyle = {
  flexShrink: 0,
  fontFamily: 'var(--mono)',
  fontSize: '0.65rem',
  color: 'var(--text-muted)',
  whiteSpace: 'nowrap' as const,
};
function alertIconStyle(level: AlertLevel) {
  return {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    color: levelColor(level),
    lineHeight: 1,
  };
}
const recentRowStyle = {
  display: 'grid',
  gridTemplateColumns: '4.5rem minmax(0, 14rem) 1fr',
  gap: '0.6rem',
  marginBottom: '0.18rem',
  alignItems: 'baseline',
};
const recentTimeStyle = { color: 'var(--text-muted)' };
const recentSubjectStyle = {
  color: 'var(--accent-dim)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap' as const,
};
const recentBodyStyle = {
  color: 'var(--text-dim)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap' as const,
};

const widgetSlotStyle = { marginTop: '1rem' };

function Panel({
  label,
  children,
  style,
  action,
}: {
  label: string;
  children: any;
  style?: Record<string, any>;
  action?: any;
}) {
  return (
    <section style={{ ...panelStyle, ...style }}>
      <div style={panelLabelRowStyle}>
        <span style={panelLabelStyle}>{label}</span>
        {action}
      </div>
      {children}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={metricStyle}>
      <span style={metricValueStyle}>{value}</span>
      <span style={metricLabelStyle}>{label}</span>
    </div>
  );
}

const metricStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  alignItems: 'flex-end',
  lineHeight: 1.1,
};
const metricValueStyle = {
  fontFamily: 'var(--mono)',
  fontSize: '0.95rem',
  color: 'var(--text)',
  fontWeight: 500,
};
const metricLabelStyle = {
  fontSize: '0.6rem',
  letterSpacing: '0.12em',
  textTransform: 'uppercase' as const,
  color: 'var(--text-muted)',
  marginTop: '0.1rem',
};

function Stat({
  value,
  unit,
  small,
}: {
  value: string;
  unit: string;
  small?: boolean;
}) {
  return (
    <div>
      <span
        style={{
          fontFamily: 'var(--mono)',
          fontSize: small ? '0.95rem' : '1.7rem',
          fontWeight: small ? 400 : 600,
          color: small ? 'var(--text-dim)' : 'var(--text)',
          lineHeight: 1,
        }}
      >
        {value}
      </span>{' '}
      <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>
        {unit}
      </span>
    </div>
  );
}

function Empty({ children }: { children: any }) {
  return (
    <div
      style={{
        color: 'var(--text-muted)',
        fontStyle: 'italic',
        fontSize: '0.78rem',
        padding: '0.3rem 0',
      }}
    >
      {children}
    </div>
  );
}

function BellIcon() {
  return (
    <svg
      width="14"
      height="14"
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

function CloseIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.4"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <line x1="5" y1="5" x2="19" y2="19" />
      <line x1="19" y1="5" x2="5" y2="19" />
    </svg>
  );
}

// Per-level glyph matching the its-alerts toast icons so an alert reads the
// same in the toast and this panel. Color inherited from the parent.
function LevelIcon({ level, size = 14 }: { level: AlertLevel; size?: number }) {
  const stroke = {
    width: size,
    height: size,
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
          width={size}
          height={size}
          viewBox="0 0 16 16"
          fill="currentColor"
          stroke="none"
        >
          <path d="M4.85 1.4 L11.15 1.4 L14.6 4.85 L14.6 11.15 L11.15 14.6 L4.85 14.6 L1.4 11.15 L1.4 4.85 Z" />
          <rect x="7.3" y="4.5" width="1.4" height="5.2" rx="0.45" fill="var(--bg)" />
          <circle cx="8" cy="11.55" r="0.85" fill="var(--bg)" />
        </svg>
      );
  }
}


function levelColor(level: AlertLevel): string {
  return level === 'info'
    ? 'var(--accent)'
    : level === 'warn'
    ? 'var(--status-stale)'
    : 'var(--status-error)';
}

function fmtUptime(s: number): string {
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
  if (s < 86400)
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}
function fmtAgo(s: number): string {
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
function fmtTime(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}
const fmtClock = fmtTime;
function fmtCount(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
function fmtRate(r: number): string {
  // Sub-10/s keeps a decimal so 0.2 doesn't display as "0".
  return r >= 10 ? `${Math.round(r)}` : r.toFixed(1);
}
// Match a concrete subject tail ("m007.tlm") against a declared path template
// ("{midas_id}.tlm"): segment counts must match, a {placeholder} matches any
// single token, literals must match exactly.
function matchesPath(tail: string, template: string): boolean {
  const t = tail.split('.');
  const p = template.split('.');
  if (t.length !== p.length) return false;
  return p.every((seg, i) => /^\{[a-z_][a-z0-9_]*\}$/.test(seg) || seg === t[i]);
}

function shortSubject(subject: string): string {
  // Drop the leading "its." for density.
  return subject.startsWith('its.') ? subject.slice(4) : subject;
}
function previewOf(payload: unknown): string {
  try {
    const s = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return s.length > 200 ? s.slice(0, 200) + '…' : s;
  } catch {
    return String(payload).slice(0, 200);
  }
}
