// Shared loading widget for plugin-chunk fetches: the host uses it on tab nav,
// plugins use it in Suspense fallbacks for in-plugin splits (e.g. cesium). One
// visual language so every loading boundary looks the same.

export function Loading({
  pluginId,
  sublabel,
}: {
  pluginId: string;
  sublabel?: string;
}) {
  return (
    <div style={centerStyle}>
      <div class="its-loading" style={innerStyle}>
        <div style={labelRowStyle}>
          <span style={prefixStyle}>INIT</span>
          <span style={idStyle}>
            {pluginId}
            {sublabel ? <span style={sublabelStyle}>/ {sublabel}</span> : null}
          </span>
        </div>
        <div style={trackStyle}>
          <div class="its-loading-bar" />
        </div>
      </div>
    </div>
  );
}

const centerStyle = {
  position: 'fixed' as const,
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'none' as const,
};
const innerStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  alignItems: 'center',
  gap: '0.7rem',
  minWidth: '12rem',
};
const labelRowStyle = {
  display: 'flex',
  alignItems: 'baseline',
  gap: '0.55rem',
  fontFamily: 'var(--mono)',
};
const prefixStyle = {
  color: 'var(--text-muted)',
  fontSize: '0.7rem',
  letterSpacing: '0.15em',
};
const idStyle = {
  color: 'var(--text)',
  fontSize: '0.95rem',
  letterSpacing: '0.02em',
};
const sublabelStyle = {
  color: 'var(--text-dim)',
  fontSize: '0.85rem',
  marginLeft: '0.4rem',
};
const trackStyle = {
  width: '10rem',
  height: '2px',
  background: 'var(--border-dim)',
  borderRadius: '2px',
  overflow: 'hidden',
};
