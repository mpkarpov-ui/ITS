// Schema-driven Settings view: plugins declare a `settings` schema (via
// defineSettings) and the platform renders the controls. Control primitives
// stay internal to this file (nothing exported) so plugins can't drift from
// the standard rendering.

import { useEffect, useMemo, useState } from 'preact/hooks';
import { useLocation } from 'wouter';
import {
  defineSettings,
  discoveredSettingsPluginIds,
  loadPluginSettings,
  useSetting,
  type SettingsSchema,
  type SettingSpec,
} from '@its/sdk-react';
import './Settings.css';

// Global schema (platform-owned).
const GLOBAL_SETTINGS = defineSettings({
  showNavRail: {
    type: 'boolean',
    label: 'Show navigation rail',
    default: true,
    hint: 'Thin left rail for switching between plugins. Off relies on the command palette (Ctrl/Cmd+K).',
  },
  lightMode: {
    type: 'boolean',
    label: 'High contrast display (light mode)',
    default: false,
    hint: 'Pure-white background with dark text for sunlit environments (range tents, desert launches).',
  },
} as const);

// The sidebar comes from discoveredSettingsPluginIds(), a build-time glob of
// plugins shipping ui/settings.ts; no plugin chunks load just to list them. On
// tab click, that plugin's settings.ts (schema only, no components) is
// lazy-loaded and cached. The main plugin bundle never loads for /settings.

export function Settings() {
  // Build-time list, synchronous; sorted for stable sidebar order.
  const pluginIds = useMemo(
    () => discoveredSettingsPluginIds().sort((a, b) => a.localeCompare(b)),
    [],
  );

  const [schemas, setSchemas] = useState<Map<string, SettingsSchema>>(
    new Map(),
  );
  const [loadingPlugin, setLoadingPlugin] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useSetting<string>(
    'settings',
    'lastTab',
    'global',
  );
  const [, setLocation] = useLocation();

  const currentTab = useMemo(() => {
    if (activeTab === 'global') return 'global';
    if (pluginIds.includes(activeTab)) return activeTab;
    return 'global';
  }, [activeTab, pluginIds]);

  // Lazy-load the active plugin's settings module on first selection.
  useEffect(() => {
    if (currentTab === 'global') return;
    if (schemas.has(currentTab)) return;
    let cancelled = false;
    setLoadingPlugin(currentTab);
    loadPluginSettings(currentTab)
      ?.then((mod) => {
        if (cancelled) return;
        const schema = (mod as { settings?: SettingsSchema } | undefined)
          ?.settings;
        if (schema) {
          setSchemas((prev) => new Map(prev).set(currentTab, schema));
        }
      })
      .catch(() => {
        // Glob matched but import failed (rare, HMR window); re-click to retry.
      })
      .finally(() => {
        if (!cancelled) setLoadingPlugin((p) => (p === currentTab ? null : p));
      });
    return () => {
      cancelled = true;
    };
  }, [currentTab, schemas]);

  const currentSchema =
    currentTab === 'global' ? GLOBAL_SETTINGS : schemas.get(currentTab);
  const currentScope = currentTab === 'global' ? 'global' : currentTab;
  const currentLabel = currentTab === 'global' ? 'Global' : currentTab;

  return (
    <div class="settings-page">
      <header class="settings-header">
        <button class="settings-back" onClick={() => setLocation('/')}>
          ← Home
        </button>
        <span class="settings-title">Settings</span>
      </header>
      <div class="settings-layout">
        <nav class="settings-sidebar">
          <SidebarItem
            label="Global"
            active={currentTab === 'global'}
            onClick={() => setActiveTab('global')}
          />
          {pluginIds.map((id) => (
            <SidebarItem
              key={id}
              label={id}
              active={currentTab === id}
              onClick={() => setActiveTab(id)}
            />
          ))}
        </nav>
        <main class="settings-panel">
          {currentSchema ? (
            <SchemaPanel
              title={currentLabel}
              scope={currentScope}
              schema={currentSchema}
            />
          ) : loadingPlugin === currentTab ? (
            <p class="settings-empty">loading…</p>
          ) : (
            <p class="settings-empty">Select a category.</p>
          )}
        </main>
      </div>
    </div>
  );
}

function SidebarItem({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      class={`settings-sidebar-item ${active ? 'settings-sidebar-item-active' : ''}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function SchemaPanel({
  title,
  scope,
  schema,
}: {
  title: string;
  scope: string;
  schema: SettingsSchema;
}) {
  return (
    <div>
      <h2 class="settings-panel-title">{title}</h2>
      <div class="settings-fields">
        {Object.entries(schema).map(([key, spec]) => (
          <FieldRow key={key} scope={scope} fieldKey={key} spec={spec} />
        ))}
      </div>
    </div>
  );
}

function FieldRow({
  scope,
  fieldKey,
  spec,
}: {
  scope: string;
  fieldKey: string;
  spec: SettingSpec;
}) {
  return (
    <label class="settings-field">
      <span class="settings-field-label">{spec.label}</span>
      <Control scope={scope} fieldKey={fieldKey} spec={spec} />
      {spec.hint && <span class="settings-field-hint">{spec.hint}</span>}
    </label>
  );
}

function Control({
  scope,
  fieldKey,
  spec,
}: {
  scope: string;
  fieldKey: string;
  spec: SettingSpec;
}) {
  switch (spec.type) {
    case 'string':
      return <StringControl scope={scope} fieldKey={fieldKey} spec={spec} />;
    case 'number':
      return <NumberControl scope={scope} fieldKey={fieldKey} spec={spec} />;
    case 'boolean':
      return <BooleanControl scope={scope} fieldKey={fieldKey} spec={spec} />;
    case 'enum':
      return <EnumControl scope={scope} fieldKey={fieldKey} spec={spec} />;
  }
}

function StringControl({
  scope,
  fieldKey,
  spec,
}: {
  scope: string;
  fieldKey: string;
  spec: Extract<SettingSpec, { type: 'string' }>;
}) {
  const [v, setV] = useSetting<string>(scope, fieldKey, spec.default);
  return (
    <input
      type="text"
      value={v}
      placeholder={spec.placeholder}
      class="settings-input"
      onInput={(e) => setV((e.target as HTMLInputElement).value)}
    />
  );
}

function NumberControl({
  scope,
  fieldKey,
  spec,
}: {
  scope: string;
  fieldKey: string;
  spec: Extract<SettingSpec, { type: 'number' }>;
}) {
  const [v, setV] = useSetting<number>(scope, fieldKey, spec.default);
  return (
    <input
      type="number"
      value={v}
      step={spec.step}
      min={spec.min}
      max={spec.max}
      class="settings-input"
      onInput={(e) => {
        const n = Number((e.target as HTMLInputElement).value);
        if (Number.isFinite(n)) setV(n);
      }}
    />
  );
}

function BooleanControl({
  scope,
  fieldKey,
  spec,
}: {
  scope: string;
  fieldKey: string;
  spec: Extract<SettingSpec, { type: 'boolean' }>;
}) {
  const [v, setV] = useSetting<boolean>(scope, fieldKey, spec.default);
  return (
    <button
      type="button"
      onClick={() => setV(!v)}
      class={`settings-toggle ${v ? 'settings-toggle-on' : ''}`}
      aria-pressed={v}
    >
      <span class="settings-toggle-knob" />
      <span class="settings-toggle-label">{v ? 'On' : 'Off'}</span>
    </button>
  );
}

function EnumControl({
  scope,
  fieldKey,
  spec,
}: {
  scope: string;
  fieldKey: string;
  spec: Extract<SettingSpec, { type: 'enum' }>;
}) {
  const [v, setV] = useSetting<string>(scope, fieldKey, spec.default);
  return (
    <select
      value={v}
      class="settings-input"
      onChange={(e) => setV((e.target as HTMLSelectElement).value)}
    >
      {spec.options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
