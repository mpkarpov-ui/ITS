// Hooks over the formats / active_format globals; YAML is parsed inside so
// consumers get a typed FormatFile. Parse errors surface via the `error`
// field rather than throwing, so the overlay keeps rendering fallbacks when
// the active format is broken.

import { useMemo } from 'preact/hooks';
import yaml from 'js-yaml';
import { globals, useGlobal } from '@its/sdk-react';
import type { ActiveFormat, Formats } from '@its/contracts/iss-live';
import type { FormatFile } from './types';

const EMPTY_FORMATS: Formats = { entries: {} };
const EMPTY_ACTIVE: ActiveFormat = { name: null };

export function useFormatsMap(): {
  entries: Record<string, string>;
  ready: boolean;
} {
  const [value, , meta] = useGlobal(globals.issLive.formats);
  return { entries: (value ?? EMPTY_FORMATS).entries, ready: meta.ready };
}

export function useActiveFormatName(): {
  name: string | null;
  ready: boolean;
} {
  const [value, , meta] = useGlobal(globals.issLive.activeFormat);
  return { name: (value ?? EMPTY_ACTIVE).name, ready: meta.ready };
}

export function useActiveFormat(): {
  format: FormatFile | null;
  name: string | null;
  error: string | null;
  ready: boolean;
} {
  const { entries, ready: formatsReady } = useFormatsMap();
  const { name, ready: activeReady } = useActiveFormatName();

  return useMemo(() => {
    const ready = formatsReady && activeReady;
    if (!name) return { format: null, name: null, error: null, ready };
    const raw = entries[name];
    if (!raw) {
      return { format: null, name, error: `Format "${name}" not found in formats bucket`, ready };
    }
    try {
      const parsed = yaml.load(raw) as FormatFile;
      if (!parsed || typeof parsed !== 'object') {
        return { format: null, name, error: 'Format YAML did not parse to an object', ready };
      }
      return { format: parsed, name, error: null, ready };
    } catch (e: any) {
      return { format: null, name, error: e?.message ?? String(e), ready };
    }
  }, [entries, name, formatsReady, activeReady]);
}

// Imperative writers that preserve the existing dict and active-format pointer.
export function useFormatsApi() {
  const [formatsValue, setFormats] = useGlobal(globals.issLive.formats);
  const [activeValue, setActive] = useGlobal(globals.issLive.activeFormat);
  const entries = (formatsValue ?? EMPTY_FORMATS).entries;
  const activeName = (activeValue ?? EMPTY_ACTIVE).name;

  const saveFormat = (name: string, yamlText: string) => {
    setFormats({ entries: { ...entries, [name]: yamlText } });
  };
  const deleteFormat = (name: string) => {
    const next = { ...entries };
    delete next[name];
    setFormats({ entries: next });
    if (activeName === name) setActive({ name: null });
  };
  const renameFormat = (oldName: string, newName: string) => {
    if (oldName === newName || !entries[oldName] || entries[newName]) return;
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(entries)) {
      next[k === oldName ? newName : k] = v;
    }
    setFormats({ entries: next });
    if (activeName === oldName) setActive({ name: newName });
  };
  const setActiveFormat = (name: string | null) => setActive({ name });

  return { entries, activeName, saveFormat, deleteFormat, renameFormat, setActiveFormat };
}
