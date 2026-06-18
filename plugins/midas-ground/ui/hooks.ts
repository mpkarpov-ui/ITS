// Target-aware hook layer: resolve the selected target from context, build the
// typed subject / command descriptor, hand off to the SDK hooks.

import { useCallback } from 'preact/hooks';
import { commands, subjects, useCommand, useStream } from '@its/sdk-react';
import { useTarget } from './TargetContext';

// Canonical Tlm stream for the selected target. Returns useStream's result plus
// the resolved subject so views pass it to <Graph> without re-deriving.
export function useMidasTlm() {
  const { target } = useTarget();
  const subject = subjects.midasGround.tlm({ midas_id: target });
  const stream = useStream(subject);
  return { ...stream, subject };
}

// midas_id "m007" -> MShell serial "7". Feather firmware addresses rockets by
// bare integer serial (atoi), so strip "m" and zero-padding. null when the
// target isn't the m<NNN> shape.
export function midasSerial(target: string): string | null {
  const m = /^m0*(\d+)$/.exec(target);
  return m ? m[1] : null;
}

// Target-aware MShell sender. Broadcasts a raw line to every feather; only the
// one matching the target's serial acts. send() prepends the serial:
// send('fire', 'A') -> "fire 7 A".
export function useMidasShell() {
  const { target } = useTarget();
  const broadcast = useCommand(commands.issFeather.mshell());
  const serial = midasSerial(target);
  const send = useCallback(
    (verb: string, ...args: string[]) => {
      if (serial === null) return; // no addressable target; button is a no-op
      const line = [verb, serial, ...args].join(' ');
      const cmdId =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      broadcast({ line, cmd_id: cmdId });
    },
    [broadcast, serial],
  );
  return { serial, send };
}

// Command lookup against the mock-rocket tree, bound to the selected target.
// The `as any` bridges useCommand's per-instance vs broadcast overload
// ambiguity; every commands.mockRocket entry is (instance) => Descriptor, so
// passing `target` always hits the per-instance overload at runtime.
export function useMidasCommand<V extends keyof typeof commands.mockRocket>(verb: V) {
  const { target } = useTarget();
  const descriptor = commands.mockRocket[verb](target);
  return useCommand(descriptor as any);
}
