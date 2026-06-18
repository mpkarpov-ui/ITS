// Shared control-deck primitives, mirroring frontend-host/Home.tsx's
// Panel/Empty/Stat pattern for platform-wide visual consistency.

import type { ComponentChildren, JSX } from 'preact';

export function Panel({
  label,
  right,
  children,
  style,
}: {
  label: string;
  right?: ComponentChildren;
  children: ComponentChildren;
  style?: JSX.CSSProperties;
}) {
  return (
    <section style={{ ...panelStyle, ...style }}>
      <div style={panelHeaderStyle}>
        <span style={panelLabelStyle}>{label}</span>
        {right && <span style={{ marginLeft: 'auto' }}>{right}</span>}
      </div>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ComponentChildren }) {
  return <div style={emptyStyle}>{children}</div>;
}

export function FieldLabel({ children }: { children: ComponentChildren }) {
  return <span style={fieldLabelStyle}>{children}</span>;
}

export function StatusDot({ color }: { color: string }) {
  return <span style={{ ...dotStyle, background: color }} />;
}

// Chip button; `tone` shifts the active color (accent default, live, stale, error).
export function ChipButton({
  active,
  onClick,
  tone = 'accent',
  disabled,
  children,
}: {
  active: boolean;
  onClick: () => void;
  tone?: 'accent' | 'live' | 'stale' | 'error' | 'neutral';
  disabled?: boolean;
  children: ComponentChildren;
}) {
  const toneColor =
    tone === 'live' ? 'var(--status-live)'
    : tone === 'stale' ? 'var(--status-stale)'
    : tone === 'error' ? 'var(--status-error)'
    : tone === 'neutral' ? 'var(--text)'
    : 'var(--accent)';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        ...chipButtonStyle,
        ...(active ? {
          borderColor: toneColor,
          color: toneColor,
        } : {}),
        ...(disabled ? { opacity: 0.5, cursor: 'not-allowed' } : {}),
      }}
    >
      {children}
    </button>
  );
}

export function TextInput({
  value,
  onInput,
  placeholder,
  style,
}: {
  value: string;
  onInput: (next: string) => void;
  placeholder?: string;
  style?: JSX.CSSProperties;
}) {
  return (
    <input
      type="text"
      value={value}
      onInput={(e) => onInput((e.currentTarget as HTMLInputElement).value)}
      placeholder={placeholder}
      style={{ ...textInputStyle, ...style }}
    />
  );
}

const panelStyle: JSX.CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: '6px',
  padding: '0.7rem 0.9rem',
  minWidth: 0,
};
const panelHeaderStyle: JSX.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  marginBottom: '0.55rem',
};
const panelLabelStyle: JSX.CSSProperties = {
  fontSize: '0.65rem',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};
const emptyStyle: JSX.CSSProperties = {
  color: 'var(--text-muted)',
  fontStyle: 'italic',
  fontSize: '0.78rem',
  padding: '0.3rem 0',
};
const fieldLabelStyle: JSX.CSSProperties = {
  fontSize: '0.65rem',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
  display: 'block',
  marginBottom: '0.3rem',
};
const dotStyle: JSX.CSSProperties = {
  width: '0.5rem',
  height: '0.5rem',
  borderRadius: '50%',
  display: 'inline-block',
  flexShrink: 0,
};
const chipButtonStyle: JSX.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: '0.7rem',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: '3px',
  color: 'var(--text-dim)',
  padding: '0.35rem 0.7rem',
  cursor: 'pointer',
  transition: 'border-color 120ms, color 120ms',
};
const textInputStyle: JSX.CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: '3px',
  color: 'var(--text)',
  padding: '0.4rem 0.55rem',
  fontFamily: 'var(--mono)',
  fontSize: '0.82rem',
  width: '100%',
  boxSizing: 'border-box',
};
