import { useEffect, useState } from 'preact/hooks';
import type { ComponentType } from 'preact';
import { Loading, loadPluginModule } from '@its/sdk-react';

// Plugins own the entire viewport; the host adds no chrome. Error and loading
// states render centered so they read as intentional, not as host styling
// leaking into the plugin's space.
export function TabContent({
  pluginId,
  componentName,
}: {
  pluginId: string;
  componentName: string;
}) {
  const [Component, setComponent] = useState<ComponentType | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loaderPromise = loadPluginModule(pluginId);
    if (!loaderPromise) {
      setError(`no chunk for plugin ${pluginId}`);
      return;
    }
    loaderPromise
      .then((mod) => {
        if (cancelled) return;
        const C = mod[componentName] as ComponentType | undefined;
        if (!C) setError(`plugin ${pluginId} does not export ${componentName}`);
        else setComponent(() => C);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [pluginId, componentName]);

  if (error) return <ErrorState pluginId={pluginId} message={error} />;
  if (!Component) return <Loading pluginId={pluginId} />;
  return <Component />;
}

// Mirrors the Loading widget's layout so a failed load reads as its sibling.
function ErrorState({ pluginId, message }: { pluginId: string; message: string }) {
  return (
    <div style={errorCenterStyle}>
      <div style={errorInnerStyle}>
        <div style={errorLabelRowStyle}>
          <span style={errorPrefixStyle}>ERR</span>
          <span style={errorIdStyle}>{pluginId}</span>
        </div>
        <div style={errorMessageStyle}>{message}</div>
      </div>
    </div>
  );
}

const errorCenterStyle = {
  position: 'fixed' as const,
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'none' as const,
};
const errorInnerStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  alignItems: 'center',
  gap: '0.7rem',
  minWidth: '12rem',
};
const errorLabelRowStyle = {
  display: 'flex',
  alignItems: 'baseline',
  gap: '0.55rem',
  fontFamily: 'var(--mono)',
};
const errorPrefixStyle = {
  color: 'var(--status-error)',
  fontSize: '0.7rem',
  letterSpacing: '0.15em',
};
const errorIdStyle = {
  color: 'var(--text)',
  fontSize: '0.95rem',
  letterSpacing: '0.02em',
};
const errorMessageStyle = {
  fontFamily: 'var(--mono)',
  fontSize: '0.75rem',
  color: 'var(--text-dim)',
  maxWidth: '24rem',
  textAlign: 'center' as const,
};
