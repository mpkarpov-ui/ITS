import { useEffect, useState } from 'preact/hooks';
import type { SubjectPayload, SubjectUnion } from '@its/contracts/_subjects';
import { subscribeHistory } from './ws-bridge';

// Up to the last `n` payloads on `subject`, oldest first. Backed by the shared
// per-subject ring buffer in the WS bridge, so components reading the same
// subject share one trace. History accumulates from first-subscriber mount;
// older values aren't reconstructed (that needs JetStream replay).
export function useHistory<S extends SubjectUnion>(
  subject: S,
  n: number = 100,
): SubjectPayload<S>[] {
  const [history, setHistory] = useState<SubjectPayload<S>[]>([]);
  useEffect(() => {
    // Reset on subject change: subscribeHistory only fires when the buffer is
    // non-empty, so switching to an empty subject would otherwise leave the
    // previous subject's history rendered. The shared buffer is untouched.
    setHistory([]);
    return subscribeHistory(subject, (buf) => {
      // Slice to the caller's window; the shared buffer can hold more for
      // components asking for greater depth.
      const sliced = buf.length > n ? buf.slice(buf.length - n) : buf.slice();
      setHistory(sliced as SubjectPayload<S>[]);
    });
  }, [subject, n]);
  return history;
}
