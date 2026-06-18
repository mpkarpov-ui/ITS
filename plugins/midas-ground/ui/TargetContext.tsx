// Plugin-local context for "which MIDAS is selected".
//
// The target list is discovered from the telemetry cache (via useKnownSubjects),
// not hardcoded: any MIDAS id that has transmitted appears, survives reload
// (cache is localStorage-backed per telemetryRetention), and clears only when
// the TLM cache clears. The selected target is per-browser via useSetting under
// its.settings.midas-ground.target.

import { ComponentChildren, createContext } from 'preact';
import { useContext, useEffect, useMemo } from 'preact/hooks';
import { useLocation } from 'wouter';
import {
  knownSubjects,
  registerCommand,
  subjects,
  subscribe,
  useKnownSubjects,
  useSetting,
} from '@its/sdk-react';

export interface TargetOption {
  value: string;
  label: string;
}

// Wildcard over every canonical tlm subject: its.midas-ground.*.*.tlm.
const TLM_PATTERN = subjects.midasGround.tlm({ midas_id: '*' });

// Extract midas_id from tlm subject keys, dropping the wildcard discovery key
// (its.midas-ground.*.*.tlm) whose id segment is '*'.
function midasIdsFrom(subjectKeys: string[]): string[] {
  const ids = new Set<string>();
  for (const key of subjectKeys) {
    const seg = key.split('.');
    const id = seg.length === 5 ? seg[3] : '';
    if (id && id !== '*') ids.add(id);
  }
  return [...ids].sort();
}

// "m007" -> "MIDAS 007"; ids that aren't the mNNN shape display raw.
function labelFor(id: string): string {
  return /^m\d+$/.test(id) ? `MIDAS ${id.slice(1)}` : id;
}

interface TargetCtx {
  target: string;
  setTarget: (t: string) => void;
  options: TargetOption[];
}

const Ctx = createContext<TargetCtx | null>(null);

export function TargetProvider({ children }: { children: ComponentChildren }) {
  const [target, setTarget] = useSetting<string>('midas-ground', 'target', '');
  const [, setLocation] = useLocation();

  // Discovered targets = MIDAS ids present in the telemetry cache.
  const knownTlmSubjects = useKnownSubjects(TLM_PATTERN);
  const options = useMemo<TargetOption[]>(
    () => midasIdsFrom(knownTlmSubjects).map((id) => ({ value: id, label: labelFor(id) })),
    [knownTlmSubjects],
  );

  // Discovery + pre-warm. The wildcard subscription surfaces new MIDAS ids; for
  // each we open a per-id subscription so its history accumulates even when
  // another target is selected and a per-id key lands in the cache (which is
  // what makes the id appear in `options` and persist across reload).
  useEffect(() => {
    const perId = new Map<string, () => void>();
    const ensure = (id: string) => {
      if (!id || id === '*' || perId.has(id)) return;
      perId.set(id, subscribe(subjects.midasGround.tlm({ midas_id: id }), () => {}));
    };
    midasIdsFrom(knownSubjects(TLM_PATTERN)).forEach(ensure);
    const unsub = subscribe(TLM_PATTERN, (_v, concrete) => ensure(concrete.split('.')[3]));
    return () => {
      unsub();
      perId.forEach((c) => c());
    };
  }, []);

  // Keep the selection valid: fall to the first discovered option when the
  // stored target isn't among them (first run or cleared).
  useEffect(() => {
    if (options.length > 0 && !options.some((o) => o.value === target)) {
      setTarget(options[0].value);
    }
  }, [options, target]);

  // Tab-switch shortcuts, live only while a midas view is mounted. Literal Ctrl
  // (not Mod) because Cmd+1..3 is browser-tab switching on macOS.
  useEffect(() => {
    // showInPalette:false hides the redundant palette rows (they duplicate the
    // tab switcher) while keeping the Ctrl+n shortcut live.
    const tabs: {
      id: string;
      title: string;
      route: string;
      key: string;
      showInPalette?: boolean;
    }[] = [
      { id: 'midas-ground.go-flight', title: 'Switch to Flight', route: '/flight', key: 'Ctrl+1', showInPalette: false },
      { id: 'midas-ground.go-commanding', title: 'Switch to Commanding', route: '/commanding', key: 'Ctrl+2', showInPalette: false },
      { id: 'midas-ground.go-map', title: 'Switch to Map', route: '/map', key: 'Ctrl+3', showInPalette: false },
    ];
    const unregs = tabs.map((t) =>
      registerCommand({
        id: t.id,
        source: 'midas-ground',
        title: t.title,
        hint: `Jump to ${t.route}`,
        shortcut: t.key,
        showInPalette: t.showInPalette,
        action: () => setLocation(t.route),
      }),
    );
    return () => unregs.forEach((u) => u());
  }, [setLocation]);

  return (
    <Ctx.Provider value={{ target, setTarget, options }}>
      {children}
    </Ctx.Provider>
  );
}

export function useTarget(): TargetCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTarget called outside TargetProvider');
  return v;
}
