// Build-time discovery of plugin UI entries. Vite resolves import.meta.glob at
// build time, matching every plugins/<id>/ui/index.tsx into its own lazy
// code-split chunk. Dropping in a plugin file is enough; no frontend edits.
const modules = import.meta.glob('../../../plugins/*/ui/index.tsx');

const loaders = new Map<string, () => Promise<Record<string, unknown>>>();
for (const [path, loader] of Object.entries(modules)) {
  const match = path.match(/\/plugins\/([^/]+)\/ui\//);
  if (match) loaders.set(match[1], loader as () => Promise<Record<string, unknown>>);
}

export function loadPluginModule(pluginId: string): Promise<Record<string, unknown>> | null {
  const loader = loaders.get(pluginId);
  return loader ? loader() : null;
}

export function discoveredPluginIds(): string[] {
  return [...loaders.keys()];
}

// Settings live in `ui/settings.ts` (just a defineSettings() export), kept
// separate from `ui/index.tsx` so the Settings view can load the schema alone
// without pulling in a plugin's heavy main bundle (e.g. cesium). The glob only
// matches existing files, so settingsLoaders' keys are exactly the plugins that
// expose settings.
const settingsModules = import.meta.glob('../../../plugins/*/ui/settings.ts');

const settingsLoaders = new Map<string, () => Promise<Record<string, unknown>>>();
for (const [path, loader] of Object.entries(settingsModules)) {
  const match = path.match(/\/plugins\/([^/]+)\/ui\/settings\.ts$/);
  if (match)
    settingsLoaders.set(
      match[1],
      loader as () => Promise<Record<string, unknown>>,
    );
}

export function loadPluginSettings(
  pluginId: string,
): Promise<Record<string, unknown>> | null {
  const loader = settingsLoaders.get(pluginId);
  return loader ? loader() : null;
}

export function discoveredSettingsPluginIds(): string[] {
  return [...settingsLoaders.keys()];
}
