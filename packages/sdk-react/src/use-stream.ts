import { useEffect, useState } from 'preact/hooks';
import type { SubjectPayload, SubjectUnion } from '@its/contracts/_subjects';
import { getLastValue, subscribe as wsSubscribe } from './ws-bridge';

// Latest payload on a subject plus its arrival time. One re-render per message,
// zero idle overhead. Pair with useStaleAfter for a reactive silence indicator.
//
//   const { value, lastSeen } = useStream(subjects.x.y());
//
// value is null until the first message; lastSeen is the arrival Date.now().
export interface StreamResult<T> {
  value: T | null;
  lastSeen: number | null;
}

// Empty tokens ("..", leading/trailing dot) are invalid on NATS and drop the
// whole connection if subscribed, so treat them as nothing to subscribe.
function subscribable(subject: string): boolean {
  return subject.length > 0 && !subject.split('.').includes('');
}

export function useStream<S extends SubjectUnion>(
  subject: S,
): StreamResult<SubjectPayload<S>> {
  const [state, setState] = useState<StreamResult<SubjectPayload<S>>>(() => ({
    value: null,
    lastSeen: null,
  }));

  useEffect(() => {
    if (!subscribable(subject)) {
      setState({ value: null, lastSeen: null });
      return;
    }
    // On subject change, warm-start from the WS-bridge cache if a value is
    // there, else reset to {null, null}. The real lastSeen flows through so a
    // value cached 30s ago reads as 30s old, not just-arrived.
    const cached = getLastValue(subject);
    setState(
      cached !== null
        ? { value: cached.value as SubjectPayload<S>, lastSeen: cached.lastSeen }
        : { value: null, lastSeen: null },
    );
    return wsSubscribe(subject, (v) => {
      setState({ value: v as SubjectPayload<S>, lastSeen: Date.now() });
    });
  }, [subject]);

  return state;
}
