// Always-mounted toast stack. Subscribes to `its.*.*.alert` and renders a
// bottom-right stack; source plugin id comes from the concrete subject.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { globals, publish, registerCommand, subscribe, useGlobal } from '@its/sdk-react';
import type { Suppression } from '@its/contracts/its-alerts';
import './index.css';

export { AlertsView } from './AlertsView';

// Opening the composer is event-driven: any surface dispatches `its:create-alert`
// and the overlay-mounted AlertComposer catches it.
const CREATE_ALERT_EVENT = 'its:create-alert';

registerCommand({
  id: 'its-alerts.fire-alert',
  title: 'Fire alert',
  hint: 'Fire a manual alert',
  shortcut: 'Mod+Shift+A',
  action: () => {
    window.dispatchEvent(new CustomEvent(CREATE_ALERT_EVENT));
  },
});

type AlertLevel = 'info' | 'warn' | 'error' | 'critical';
const ALL_LEVELS: AlertLevel[] = ['info', 'warn', 'error', 'critical'];

// Blanket-mute toggle: adds/removes all four levels in the suppression global,
// leaving source/key mutes alone so flipping it off restores prior policy.
// Uses read()/update() not useGlobal so it works at module-load registration.
const EMPTY_SUPP: Suppression = { sources: [], levels: [], keys: [] };
registerCommand({
  id: 'its-alerts.toggle-mute-all',
  title: 'Toggle mute all alerts',
  hint: 'Silence every level; re-run to restore prior policy',
  shortcut: 'Mod+Shift+M',
  action: async () => {
    const cur = (await globals.itsAlerts.suppression.read()) ?? EMPTY_SUPP;
    const allMuted = ALL_LEVELS.every((l) => cur.levels.includes(l));
    const nextLevels = allMuted
      ? cur.levels.filter((l) => !ALL_LEVELS.includes(l as AlertLevel))
      : Array.from(new Set([...cur.levels, ...ALL_LEVELS]));
    globals.itsAlerts.suppression.update({ ...cur, levels: nextLevels });
  },
});

interface AlertPayload {
  level?: AlertLevel;
  title?: string;
  body?: string;
  timeout_ms?: number | null;
  key?: string | null;
  cleared?: boolean;
}

interface Toast {
  id: string;
  // null = transient (auto-dismiss); non-null = sticky (deduped by source+key).
  key: string | null;
  level: AlertLevel;
  title: string;
  body: string;
  source: string;
  ts: number;
  timeoutMs: number;
}

const MAX_VISIBLE = 5;
const DEFAULT_TIMEOUTS: Record<AlertLevel, number> = {
  info: 5_000,
  warn: 10_000,
  error: 30_000,
  critical: 60_000,
};

// Stroked with currentColor so each icon picks up the per-level CSS color.
function LevelIcon({ level }: { level: AlertLevel }) {
  const props = {
    width: 16,
    height: 16,
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
        <svg {...props}>
          <circle cx="8" cy="8" r="6.5" />
          <line x1="8" y1="7.2" x2="8" y2="11.8" />
          <circle cx="8" cy="4.6" r="0.5" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'warn':
      return (
        <svg {...props}>
          <path d="M8 1.8 L14.6 13.5 L1.4 13.5 Z" />
          <line x1="8" y1="6.2" x2="8" y2="9.8" />
          <circle cx="8" cy="11.6" r="0.5" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'error':
      return (
        <svg {...props}>
          <circle cx="8" cy="8" r="6.5" />
          <line x1="5.2" y1="5.2" x2="10.8" y2="10.8" />
          <line x1="10.8" y1="5.2" x2="5.2" y2="10.8" />
        </svg>
      );
    case 'critical':
      // Filled octagon (currentColor) with the exclamation cut in --bg, so it
      // reads as a stop sign distinct from the stroked WARN triangle.
      return (
        <svg
          width={16}
          height={16}
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

// Watermark on sticky toasts to flag which alerts won't auto-dismiss.
function PinIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <line x1="12" x2="12" y1="17" y2="22" />
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
    </svg>
  );
}

function sourceFromSubject(subject: string): string {
  // its.<plugin>.<instance>.alert  -> "<plugin>"
  const parts = subject.split('.');
  return parts[1] ?? '?';
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Exported so every surface applies the exact same mute logic.
export function isSuppressed(
  supp: Suppression | null,
  source: string,
  level: AlertLevel,
  key: string | null,
): boolean {
  if (!supp) return false;
  if (supp.sources.includes(source)) return true;
  if (supp.levels.includes(level)) return true;
  if (key && supp.keys.includes(`${source}:${key}`)) return true;
  return false;
}

export function AlertToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [suppression] = useGlobal(globals.itsAlerts.suppression);
  // subscribe runs once on mount; the live value rides this ref so policy
  // changes apply without re-subscribing.
  const suppressionRef = useRef<Suppression | null>(suppression);
  useEffect(() => {
    suppressionRef.current = suppression;
  }, [suppression]);

  useEffect(() => {
    return subscribe('its.*.*.alert', (payload, concreteSubject) => {
      const a = payload as AlertPayload;
      if (!a) return;
      const source = sourceFromSubject(concreteSubject);
      const key = a.key || null;

      // Sticky retraction: drop the matching toast. Cleared messages pass even
      // for muted sources so a toast raised before muting tears down cleanly.
      if (key && a.cleared) {
        setToasts((cur) =>
          cur.filter((t) => !(t.source === source && t.key === key)),
        );
        return;
      }

      if (typeof a.title !== 'string' || !a.title) return;
      const level: AlertLevel = a.level ?? 'info';

      if (isSuppressed(suppressionRef.current, source, level, key)) return;

      if (key) {
        // Sticky: update in place if (source, key) present, else add. No auto-dismiss.
        setToasts((cur) => {
          const idx = cur.findIndex(
            (t) => t.source === source && t.key === key,
          );
          const next: Toast = {
            id: idx >= 0 ? cur[idx].id : newId(),
            key,
            level,
            title: a.title!,
            body: a.body ?? '',
            source,
            ts: Date.now(),
            timeoutMs: 0,
          };
          if (idx >= 0) {
            const copy = cur.slice();
            copy[idx] = next;
            return copy;
          }
          return [next, ...cur].slice(0, MAX_VISIBLE);
        });
        return;
      }

      // Transient: stack newest on top, auto-dismiss.
      const timeoutMs =
        a.timeout_ms == null ? DEFAULT_TIMEOUTS[level] : a.timeout_ms;
      const toast: Toast = {
        id: newId(),
        key: null,
        level,
        title: a.title,
        body: a.body ?? '',
        source,
        ts: Date.now(),
        timeoutMs,
      };
      setToasts((cur) => [toast, ...cur].slice(0, MAX_VISIBLE));
      if (timeoutMs > 0) {
        setTimeout(() => {
          setToasts((cur) => cur.filter((t) => t.id !== toast.id));
        }, timeoutMs);
      }
    });
  }, []);

  function dismiss(id: string) {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }

  if (toasts.length === 0) return null;

  return (
    <div class="alert-toasts">
      {toasts.map((t) => (
        <div
          key={t.id}
          class={`alert-toast alert-toast-${t.level}${t.key ? ' alert-toast-sticky' : ''}`}
          onClick={() => dismiss(t.id)}
          title="click to dismiss"
        >
          <div class="alert-toast-icon" aria-hidden="true">
            <LevelIcon level={t.level} />
          </div>
          <div class="alert-toast-content">
            <div class="alert-toast-title">{t.title}</div>
            {t.body && <div class="alert-toast-body">{t.body}</div>}
            <div class="alert-toast-meta">
              <span class="alert-toast-source">from {t.source}</span>
              <span class="alert-toast-time">{fmtTime(t.ts)}</span>
            </div>
          </div>
          {t.key && (
            <div class="alert-toast-pin" aria-hidden="true">
              <PinIcon />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function fmtTime(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// Overlay-mounted composer. Hidden until an `its:create-alert` event arrives,
// then shows the modal. Suppressed in detached/popped-out windows.
export function AlertComposer() {
  const [open, setOpen] = useState(false);
  const detached = useMemo(
    () => new URLSearchParams(window.location.search).get('detached') === '1',
    [],
  );
  useEffect(() => {
    if (detached) return;
    const onOpen = () => setOpen(true);
    window.addEventListener(CREATE_ALERT_EVENT, onOpen);
    return () => window.removeEventListener(CREATE_ALERT_EVENT, onOpen);
  }, [detached]);
  if (detached || !open) return null;
  return <CreateAlertModal onClose={() => setOpen(false)} />;
}

const ALERT_LEVELS: AlertLevel[] = ['info', 'warn', 'error', 'critical'];

function levelColor(level: AlertLevel): string {
  return level === 'info'
    ? 'var(--accent)'
    : level === 'warn'
    ? 'var(--status-stale)'
    : 'var(--status-error)';
}

// Publishes to the synthetic `its.operator.manual.alert` so it can't collide
// with a real plugin's per-instance publisher. A `key` makes it sticky.
function CreateAlertModal({ onClose }: { onClose: () => void }) {
  const [level, setLevel] = useState<AlertLevel>('info');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [sticky, setSticky] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const canSend = title.trim().length > 0;

  // Mount-only focus so re-renders don't yank it mid-typing.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function send() {
    if (!canSend) return;
    publish('its.operator.manual.alert', {
      level,
      title: title.trim(),
      body: body.trim() || undefined,
      key: sticky ? `manual:${title.trim()}` : undefined,
    });
    onClose();
  }

  return (
    <div style={modalBackdropStyle} onClick={onClose}>
      <div style={modalPanelStyle} onClick={(e) => e.stopPropagation()}>
        <div style={modalTitleStyle}>Create alert</div>

        <div style={modalFieldStyle}>
          <span style={modalLabelStyle}>Level</span>
          <div style={levelRowStyle}>
            {ALERT_LEVELS.map((lv) => (
              <button
                key={lv}
                type="button"
                style={levelButtonStyle(lv, lv === level)}
                onClick={() => setLevel(lv)}
              >
                {lv}
              </button>
            ))}
          </div>
        </div>

        <div style={modalFieldStyle}>
          <span style={modalLabelStyle}>Title</span>
          <input
            ref={inputRef}
            type="text"
            value={title}
            placeholder="Short summary"
            style={modalInputStyle}
            onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
          />
        </div>

        <div style={modalFieldStyle}>
          <span style={modalLabelStyle}>Body (optional)</span>
          <textarea
            value={body}
            placeholder="Details"
            rows={3}
            style={modalTextareaStyle}
            onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)}
          />
        </div>

        <label style={stickyRowStyle}>
          <input
            type="checkbox"
            checked={sticky}
            style={stickyCheckboxStyle}
            onChange={(e) => setSticky((e.target as HTMLInputElement).checked)}
          />
          <span style={stickyLabelStyle}>
            Sticky
            <span style={stickyHintStyle}> — stays pinned until cleared</span>
          </span>
        </label>

        <div style={modalActionsStyle}>
          <button type="button" style={modalCancelStyle} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            style={modalSendStyle(canSend)}
            onClick={send}
            disabled={!canSend}
          >
            Send alert
          </button>
        </div>
      </div>
    </div>
  );
}

const modalBackdropStyle = {
  position: 'fixed' as const,
  inset: 0,
  background: 'rgba(0, 0, 0, 0.55)',
  zIndex: 1300,
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  paddingTop: '14vh',
};
const modalPanelStyle = {
  width: 'min(28rem, calc(100vw - 2rem))',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: '8px',
  boxShadow: '0 16px 48px rgba(0, 0, 0, 0.45)',
  padding: '1.1rem 1.2rem 1.2rem',
  display: 'flex',
  flexDirection: 'column' as const,
  gap: '0.85rem',
};
const modalTitleStyle = {
  fontSize: '0.95rem',
  fontWeight: 600,
  color: 'var(--text)',
  letterSpacing: '0.02em',
};
const modalFieldStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: '0.35rem',
};
const modalLabelStyle = {
  fontSize: '0.62rem',
  letterSpacing: '0.1em',
  textTransform: 'uppercase' as const,
  color: 'var(--text-muted)',
};
const levelRowStyle = {
  display: 'flex',
  gap: '0.4rem',
};
function levelButtonStyle(level: AlertLevel, active: boolean) {
  const color = levelColor(level);
  return {
    flex: 1,
    padding: '0.35rem 0',
    fontFamily: 'var(--sans)',
    fontSize: '0.72rem',
    textTransform: 'capitalize' as const,
    cursor: 'pointer',
    borderRadius: '4px',
    border: `1px solid ${active ? color : 'var(--border)'}`,
    background: active
      ? `color-mix(in srgb, ${color} 22%, transparent)`
      : 'transparent',
    color: active ? 'var(--text)' : 'var(--text-dim)',
    transition:
      'border-color 120ms ease, background-color 120ms ease, color 120ms ease',
  };
}
const modalInputStyle = {
  padding: '0.5rem 0.6rem',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: '4px',
  color: 'var(--text)',
  fontFamily: 'var(--sans)',
  fontSize: '0.85rem',
  outline: 'none',
};
const modalTextareaStyle = {
  ...modalInputStyle,
  resize: 'vertical' as const,
  minHeight: '3.5rem',
};
const stickyRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  cursor: 'pointer',
};
const stickyCheckboxStyle = {
  width: '0.95rem',
  height: '0.95rem',
  accentColor: 'var(--accent)',
  cursor: 'pointer',
  margin: 0,
};
const stickyLabelStyle = {
  fontSize: '0.8rem',
  color: 'var(--text)',
};
const stickyHintStyle = {
  color: 'var(--text-muted)',
  fontSize: '0.72rem',
};
const modalActionsStyle = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '0.5rem',
  marginTop: '0.2rem',
};
const modalCancelStyle = {
  padding: '0.45rem 0.9rem',
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: '4px',
  color: 'var(--text-dim)',
  cursor: 'pointer',
  fontFamily: 'var(--sans)',
  fontSize: '0.8rem',
};
function modalSendStyle(enabled: boolean) {
  return {
    padding: '0.45rem 0.9rem',
    background: enabled
      ? 'color-mix(in srgb, var(--accent) 22%, transparent)'
      : 'transparent',
    border: `1px solid ${enabled ? 'var(--accent)' : 'var(--border)'}`,
    borderRadius: '4px',
    color: enabled ? 'var(--text)' : 'var(--text-muted)',
    cursor: enabled ? 'pointer' : 'not-allowed',
    fontFamily: 'var(--sans)',
    fontSize: '0.8rem',
  };
}
