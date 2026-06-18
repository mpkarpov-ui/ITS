import { useEffect, useState } from 'preact/hooks';
import type { ComponentType } from 'preact';

import { loadPluginModule } from './plugin-loader';
import { getMountsForTarget } from './plugin-registry';

interface Mounted {
  pluginId: string;
  Component: ComponentType;
}

// Renders every plugin component whose manifest declares a mount at `target`,
// lazy-loading each plugin chunk on first render. Plugins can expose their own
// slots with <MountPoint target="custom">; the target string is the only
// contract, no central registration.
export function MountPoint({ target }: { target: string }) {
  const [mounted, setMounted] = useState<Mounted[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mounts = await getMountsForTarget(target);
        const loaded: Mounted[] = [];
        for (const { pluginId, mount } of mounts) {
          const loaderPromise = loadPluginModule(pluginId);
          if (!loaderPromise) {
            console.warn(`MountPoint(${target}): no chunk found for plugin ${pluginId}`);
            continue;
          }
          const mod = await loaderPromise;
          const Component = mod[mount.component] as ComponentType | undefined;
          if (!Component) {
            console.warn(
              `MountPoint(${target}): plugin ${pluginId} does not export ${mount.component}`,
            );
            continue;
          }
          loaded.push({ pluginId, Component });
        }
        if (!cancelled) setMounted(loaded);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target]);

  if (error) return <p style={{ color: 'crimson' }}>Mount error: {error}</p>;
  return (
    <>
      {mounted.map(({ pluginId, Component }) => (
        <Component key={pluginId} />
      ))}
    </>
  );
}
