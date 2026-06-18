import { useCallback } from 'preact/hooks';
import type {
  BroadcastDescriptor,
  CommandDescriptor,
} from '@its/contracts/_commands';
import { publish as wsPublish, request as wsRequest } from './ws-bridge';

// Takes a descriptor from the codegen `commands` tree (carrying the subject
// plus phantom Request/Response types) and returns a caller. With an instance
// it's per-instance request/reply; without, it's a fire-and-forget broadcast.
// The request arg is optional; omitting it sends `{}`.
//
//   const reset = useCommand(commands.timerSource.reset('dev'));
//   const ack = await reset();                  // per-instance, awaits Response
//   const resetAll = useCommand(commands.timerSource.reset());
//   resetAll();                                 // broadcast, fire-and-forget
export function useCommand<Req, Res>(
  descriptor: CommandDescriptor<Req, Res>,
): (request?: Req) => Promise<Res>;
export function useCommand<Req>(
  descriptor: BroadcastDescriptor<Req>,
): (request?: Req) => void;
export function useCommand<Req, Res>(
  descriptor: CommandDescriptor<Req, Res> | BroadcastDescriptor<Req>,
): (request?: Req) => Promise<Res> | void {
  const { subject, broadcast } = descriptor;
  return useCallback(
    (request?: Req) => {
      const payload = request ?? ({} as Req);
      if (broadcast) {
        wsPublish(subject, payload);
        return undefined as void;
      }
      return wsRequest(subject, payload) as Promise<Res>;
    },
    [subject, broadcast],
  );
}
