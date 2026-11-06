import type { ClientToServerEvents } from '../../shared/types';
import { RateLimiter, retryText } from '../services/RateLimiter';
import type { AppSocket } from './types';

/**
 * Per-user limits (shared by all their devices) on events that reach other people or
 * write to disk: [how many, per milliseconds]. Everything else only has the flood cap.
 */
const EVENT_LIMITS: Partial<Record<keyof ClientToServerEvents, [number, number]>> = {
  'chat:message': [20, 10_000],
  'chat:sticker': [10, 10_000],
  'chat:typing': [30, 10_000],
  'chat:join': [60, 60_000],
  'chat:preview': [60, 60_000],
  'chat:prefs': [60, 60_000],
  'call:invite': [10, 60_000],
  'call:join-room': [20, 60_000],
  'call:move-here': [10, 60_000],
  'call:rejoin': [10, 60_000],
  'friends:request': [20, 60_000],
  'rooms:create': [10, 60_000],
  'rooms:share': [10, 60_000],
  'rooms:remove-member': [30, 60_000],
  'profile:avatar': [10, 60_000],
  'stickers:add': [10, 60_000],
  'emoji:add': [10, 60_000],
};

/** Any events at all, per device: well above what calls (ICE candidates) need. */
const FLOOD_LIMIT = new RateLimiter(400, 10_000);

const limiters = new Map<string, RateLimiter>(
  Object.entries(EVENT_LIMITS).map(([event, [limit, windowMs]]) => [event, new RateLimiter(limit, windowMs)]),
);

/** Drops events over the limits; one with an acknowledgement is answered with the reason. */
export function applyRateLimits(socket: AppSocket): void {
  const userKey = socket.data.userId.toLowerCase();
  socket.use((packet, next) => {
    const [event] = packet;
    const wait = FLOOD_LIMIT.take(socket.id) || (limiters.get(event)?.take(userKey) ?? 0);
    if (wait === 0) return next();
    const ack = packet[packet.length - 1];
    if (typeof ack === 'function') ack({ ok: false, error: `You're doing that too often. Try again in ${retryText(wait)}.` });
  });
}
