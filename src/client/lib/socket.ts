import type { Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '../../shared/types';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export const ACK_TIMEOUT_MS = 10_000;
export const NOT_CONNECTED = 'Not connected to the server. Wait for it to reconnect and try again.';
const NO_RESPONSE = 'The server did not respond. Check your connection and try again.';

/**
 * Wraps an ack so it always runs exactly once: with the server's reply, or with an
 * error after `ms` so the UI never waits forever on a lost reply. `onTimeout` runs
 * first in that case (e.g. to undo a request the server may still process).
 */
export function withTimeout<A extends (res: { ok: false; error: string }) => void>(
  ack: A,
  onTimeout?: () => void,
  ms = ACK_TIMEOUT_MS,
): A {
  let done = false;
  const timer = setTimeout(() => {
    done = true;
    onTimeout?.();
    ack({ ok: false, error: NO_RESPONSE });
  }, ms);
  return ((res: Parameters<A>[0]) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    ack(res);
  }) as A;
}
