import type { OnlineUserSummary } from '../../shared/types';
import { callModel } from '../models/CallModel';
import { pushSubscriptionModel } from '../models/PushSubscriptionModel';
import { userModel } from '../models/UserModel';

/**
 * The people list: online users first, then offline users who can still be called
 * because their phone gets push notifications (installed PWA with notifications on).
 */
export function listDirectory(): OnlineUserSummary[] {
  const online = userModel.list();
  const onlineKeys = new Set(online.map((u) => u.id.toLowerCase()));
  const reachable: OnlineUserSummary[] = pushSubscriptionModel
    .userIds()
    .filter((id) => !onlineKeys.has(id.toLowerCase()))
    .sort((a, b) => a.localeCompare(b))
    // An offline user can already be ringing for someone else's call.
    .map((id) => ({ id, presence: callModel.findInviteFor(id) ? 'busy' : 'offline' }));
  return [...online, ...reachable];
}
