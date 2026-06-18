// Formats tab: edit / rename / delete / import / export the YAML format
// files. All entries live in one KV entry (globals.issLive.formats), so edits
// propagate to every operator machine in seconds.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import yaml from 'js-yaml';
import { usePersisted } from '@its/sdk-react';
import { useFormatsApi } from '../../formats/useFormat';
import { DEFAULT_CASSIE_YAML } from '../../formats/default-cassie';
import { ChipButton, Empty, FieldLabel, Panel, TextInput } from '../ui';

export function FormatsTab() {
  const { entries, activeName, saveFormat, deleteFormat, renameFormat, setActiveFormat } = useFormatsApi();
  const names = useMemo(() => Object.keys(entries).sort(), [entries]);

  // Which format is loaded in the editor; persisted across tab switches.
  const [selected, setSelected] = usePersisted<string | null>('iss-live', 'formats_selected', null);

  // Re-pick a default when the selection is orphaned (first load, after a
  // delete): prefer the active format, else first.
  useEffect(() => {
    if (selected && entries[selected]) return;
    if (activeName && entries[activeName]) {
      setSelected(activeName);
    } else if (names.length > 0) {
      setSelected(names[0]);
    } else {
      setSelected(null);
    }
  }, [names.join('|'), activeName]);

  const [draft, setDraft] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Re-seed the editor when the selection changes.
  useEffect(() => {
    if (selected && entries[selected]) {
      setDraft(entries[selected]);
      setDirty(false);
      validate(entries[selected]);
    } else {
      setDraft('');
      setDirty(false);
      setParseError(null);
    }
  }, [selected]);

  // Parse on every keystroke to surface typos before save; doesn't block typing.
  const validate = (text: string) => {
    try {
      yaml.load(text);
      setParseError(null);
    } catch (e: any) {
      setParseError(e?.message ?? String(e));
    }
  };
  const handleChange = (text: string) => {
    setDraft(text);
    setDirty(true);
    validate(text);
  };

  const handleSave = () => {
    if (!selected) return;
    if (parseError) return;
    saveFormat(selected, draft);
    setDirty(false);
  };

  const handleNew = () => {
    const name = window.prompt('Name for new format (kebab-case recommended):');
    if (!name) return;
    if (entries[name]) {
      alert(`Format "${name}" already exists`);
      return;
    }
    const skeleton = `name: ${name}\nversion: 1\n\nprogram_name: ""\n\ntimeline: []\nfun_facts: []\nsponsors: []\nscenes: []\naudio_presets: {}\npresets: []\n`;
    saveFormat(name, skeleton);
    setSelected(name);
  };

  const handleRename = () => {
    if (!selected) return;
    const next = window.prompt('New name:', selected);
    if (!next || next === selected) return;
    if (entries[next]) {
      alert(`Format "${next}" already exists`);
      return;
    }
    renameFormat(selected, next);
    setSelected(next);
  };

  const handleDelete = () => {
    if (!selected) return;
    if (!window.confirm(`Delete format "${selected}"? This cannot be undone.`)) return;
    deleteFormat(selected);
  };

  const handleSeedDefault = () => {
    if (entries.cassie) {
      if (!window.confirm('A "cassie" format already exists. Overwrite with the bundled defaults?')) return;
    }
    saveFormat('cassie', DEFAULT_CASSIE_YAML);
    if (!activeName) setActiveFormat('cassie');
    setSelected('cassie');
  };

  // Import saves the picked file under its basename (sans .yaml/.yml).
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const handleImport = () => fileInputRef.current?.click();
  const handleFilePicked = async (e: Event) => {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const base = file.name.replace(/\.ya?ml$/i, '');
    if (entries[base]) {
      if (!window.confirm(`A format named "${base}" already exists. Overwrite?`)) {
        target.value = '';
        return;
      }
    }
    saveFormat(base, text);
    setSelected(base);
    target.value = '';
  };

  const handleExport = () => {
    if (!selected) return;
    const blob = new Blob([draft], { type: 'application/yaml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selected}.yaml`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (names.length === 0) {
    return (
      <Panel label="Formats">
        <Empty>No formats defined yet.</Empty>
        <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.7rem' }}>
          <ChipButton active onClick={handleSeedDefault} tone="live">Seed Cassie defaults</ChipButton>
          <ChipButton active={false} onClick={handleNew}>New (empty)</ChipButton>
          <ChipButton active={false} onClick={handleImport}>Import file...</ChipButton>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".yaml,.yml"
          style={{ display: 'none' }}
          onChange={handleFilePicked}
        />
      </Panel>
    );
  }

  const isActive = selected !== null && selected === activeName;

  return (
    <div style={columnStyle}>
      <Panel
        label="Format"
        right={
          isActive
            ? <span style={activeChipStyle}>Active</span>
            : selected
              ? <ChipButton active onClick={() => setActiveFormat(selected)} tone="live">Set Active</ChipButton>
              : null
        }
      >
        <div style={topRowStyle}>
          <select
            value={selected ?? ''}
            onChange={(e) => setSelected((e.currentTarget as HTMLSelectElement).value || null)}
            style={selectStyle}
          >
            {names.map((n) => (
              <option key={n} value={n}>{n}{n === activeName ? '  (active)' : ''}</option>
            ))}
          </select>
          <ChipButton active={false} onClick={handleNew}>New</ChipButton>
          <ChipButton active={false} onClick={handleRename} disabled={!selected}>Rename</ChipButton>
          <ChipButton active={false} onClick={handleDelete} tone="error" disabled={!selected}>Delete</ChipButton>
          <div style={sepStyle} />
          <ChipButton active={false} onClick={handleImport}>Import</ChipButton>
          <ChipButton active={false} onClick={handleExport} disabled={!selected}>Export</ChipButton>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".yaml,.yml"
          style={{ display: 'none' }}
          onChange={handleFilePicked}
        />
      </Panel>

      <Panel label="Editor" style={{ flex: 1 }}>
        <FieldLabel>YAML</FieldLabel>
        <textarea
          value={draft}
          onInput={(e) => handleChange((e.currentTarget as HTMLTextAreaElement).value)}
          spellcheck={false}
          style={textareaStyle}
        />
        <div style={saveRowStyle}>
          {parseError
            ? <span style={errorStyle}>Parse error: {parseError}</span>
            : dirty
              ? <span style={dirtyStyle}>Unsaved changes</span>
              : <span style={cleanStyle}>Saved</span>
          }
          <ChipButton
            active={dirty && !parseError}
            tone="live"
            onClick={handleSave}
            disabled={!dirty || !!parseError}
          >
            Save
          </ChipButton>
        </div>
      </Panel>
    </div>
  );
}

const columnStyle: JSX.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.6rem',
};
const topRowStyle: JSX.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.4rem',
  flexWrap: 'wrap',
};
const sepStyle: JSX.CSSProperties = {
  width: '1px',
  height: '1rem',
  background: 'var(--border)',
  margin: '0 0.2rem',
};
const selectStyle: JSX.CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: '3px',
  color: 'var(--text)',
  padding: '0.4rem 0.6rem',
  fontFamily: 'var(--mono)',
  fontSize: '0.78rem',
  minWidth: '14rem',
};
const textareaStyle: JSX.CSSProperties = {
  width: '100%',
  minHeight: '22rem',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: '3px',
  color: 'var(--text)',
  fontFamily: 'var(--mono)',
  fontSize: '0.78rem',
  padding: '0.6rem 0.7rem',
  lineHeight: 1.5,
  resize: 'vertical',
  boxSizing: 'border-box',
};
const saveRowStyle: JSX.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.7rem',
  marginTop: '0.55rem',
};
const errorStyle: JSX.CSSProperties = {
  color: 'var(--status-error)',
  fontFamily: 'var(--mono)',
  fontSize: '0.72rem',
};
const dirtyStyle: JSX.CSSProperties = {
  color: 'var(--status-stale)',
  fontFamily: 'var(--mono)',
  fontSize: '0.72rem',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
};
const cleanStyle: JSX.CSSProperties = {
  color: 'var(--text-muted)',
  fontFamily: 'var(--mono)',
  fontSize: '0.72rem',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
};
const activeChipStyle: JSX.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: '0.65rem',
  letterSpacing: '0.15em',
  textTransform: 'uppercase',
  color: 'var(--status-live)',
  border: '1px solid var(--status-live)',
  borderRadius: '3px',
  padding: '0.2rem 0.55rem',
};
