// Modal for spinning up a new intake on the selected station. v1 takes raw
// JSON config; a generated form per Pydantic Config schema is a follow-up.

import { useEffect, useState } from 'preact/hooks';
import { commands, useCommand } from '@its/sdk-react';
import './ConnectWizard.css';

type PluginInfo = {
  id: string;
  description: string | null;
  runtime_kind: string | null;
};

export function ConnectWizard({
  station,
  onClose,
}: {
  station: string;
  onClose: () => void;
}) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [pluginId, setPluginId] = useState<string>('');
  const [instanceId, setInstanceId] = useState<string>('');
  const [configText, setConfigText] = useState<string>('{}');
  const [error, setError] = useState<string>('');
  const connect = useCommand(commands.itsShell.connect(station));

  useEffect(() => {
    fetch('/_plugins')
      .then((r) => r.json())
      .then((rows: PluginInfo[]) => {
        // Exclude the shell daemon itself and UI-only plugins.
        const spawnable = rows.filter(
          (p) => p.runtime_kind === 'subprocess' && p.id !== 'shell',
        );
        setPlugins(spawnable);
        if (spawnable.length > 0) setPluginId(spawnable[0].id);
      })
      .catch((e) => setError(`failed to load plugins: ${e}`));
  }, []);

  async function submit() {
    setError('');
    let config: Record<string, unknown> = {};
    try {
      config = configText.trim() ? JSON.parse(configText) : {};
    } catch (e) {
      setError(`invalid JSON: ${e}`);
      return;
    }
    try {
      const r = await connect({
        plugin: pluginId,
        config,
        instance_id: instanceId || undefined,
        autostart: true,
      });
      onClose();
    } catch (e) {
      setError(`${e}`);
    }
  }

  return (
    <div class="wizard-backdrop" onClick={onClose}>
      <div class="wizard-modal" onClick={(e) => e.stopPropagation()}>
        <div class="wizard-header">
          <span>Connect intake on {station}</span>
          <button class="wizard-close" onClick={onClose}>x</button>
        </div>

        <div class="wizard-field">
          <label>Plugin</label>
          <select value={pluginId} onChange={(e) => setPluginId((e.target as HTMLSelectElement).value)}>
            {plugins.map((p) => (
              <option key={p.id} value={p.id}>{p.id}</option>
            ))}
          </select>
        </div>

        <div class="wizard-field">
          <label>Instance id (optional)</label>
          <input
            type="text"
            value={instanceId}
            onInput={(e) => setInstanceId((e.target as HTMLInputElement).value)}
            placeholder="<plugin>:<instance_key>"
          />
        </div>

        <div class="wizard-field">
          <label>Config (JSON)</label>
          <textarea
            rows={6}
            value={configText}
            onInput={(e) => setConfigText((e.target as HTMLTextAreaElement).value)}
          />
          <div class="wizard-hint">
            v1 is raw JSON. Auto-generated form from the plugin's Pydantic Config
            schema is a planned follow-up.
          </div>
        </div>

        {error && <div class="wizard-error">{error}</div>}

        <div class="wizard-actions">
          <button class="wizard-btn" onClick={onClose}>Cancel</button>
          <button class="wizard-btn wizard-btn-primary" onClick={submit}>Connect</button>
        </div>
      </div>
    </div>
  );
}
