import type { Ack } from '../../shared/types';

/** Clients may omit the acknowledgement callback; never crash on that. */
export function safeAck<T>(ack: Ack<T> | undefined): Ack<T> {
  return typeof ack === 'function' ? ack : () => {};
}
