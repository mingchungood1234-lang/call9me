import type { RoomVisibility } from '../../shared/types';
import { isValidRoomId, PUBLIC_ROOM_ID, ROOM_ID_RULES } from '../../shared/validation';
import { friendModel } from '../models/FriendModel';
import { roomSettingsModel } from '../models/RoomSettingsModel';
import { userModel } from '../models/UserModel';
import { pushService } from '../services/PushService';
import { roomDirectory } from '../services/RoomDirectory';
import type { AppServer, AppSocket } from '../sockets/types';
import { safeAck } from '../sockets/util';

const MAX_SHARE_RECIPIENTS = 50;

function isVisibility(value: unknown): value is RoomVisibility {
  return value === 'public' || value === 'private' || value === 'link';
}

/** Creating rooms, choosing who can see them (the Rooms directory) and sharing them with friends. */
export class RoomController {
  constructor(private readonly io: AppServer) {}

  register(socket: AppSocket): void {
    const userId = socket.data.userId;

    socket.on('rooms:create', (payload, rawAck) => {
      const ack = safeAck(rawAck);
      if (!isValidRoomId(payload?.roomId)) return ack({ ok: false, error: `Invalid room ID. ${ROOM_ID_RULES}` });
      if (!isVisibility(payload.visibility)) return ack({ ok: false, error: 'Choose public or private' });
      if (payload.roomId.toLowerCase() === PUBLIC_ROOM_ID) {
        return ack({ ok: false, error: `"${PUBLIC_ROOM_ID}" is reserved for the Public chat. Pick another ID.` });
      }

      const existing = roomSettingsModel.get(payload.roomId);
      if (existing && existing.owner.toLowerCase() !== userId.toLowerCase()) {
        const reason = roomDirectory.denyReason(existing.id, userId);
        return ack({ ok: false, error: reason ?? `#${existing.id} already exists. Join it from the list or by its ID.` });
      }
      const settings = roomSettingsModel.claim(payload.roomId, userId, payload.visibility);
      roomSettingsModel.setVisibility(settings.id, payload.visibility);
      ack({ ok: true, room: roomDirectory.summary(settings) });
      roomDirectory.changed();
    });

    socket.on('rooms:set-visibility', (payload, rawAck) => {
      const ack = safeAck(rawAck);
      const settings = isValidRoomId(payload?.roomId) ? roomSettingsModel.get(payload.roomId) : undefined;
      if (!settings) return ack({ ok: false, error: 'No such room' });
      if (settings.owner.toLowerCase() !== userId.toLowerCase()) {
        return ack({ ok: false, error: `Only ${settings.owner} can change who sees #${settings.id}` });
      }
      if (!isVisibility(payload.visibility)) return ack({ ok: false, error: 'Choose public or private' });
      roomSettingsModel.setVisibility(settings.id, payload.visibility);
      ack({ ok: true });
      roomDirectory.changed();
    });

    // Sharing with friends lets them in (whatever the visibility) and sends them an invite.
    socket.on('rooms:share', (payload, rawAck) => {
      const ack = safeAck(rawAck);
      const settings = isValidRoomId(payload?.roomId) ? roomSettingsModel.get(payload.roomId) : undefined;
      if (!settings) return ack({ ok: false, error: 'No such room' });
      if (roomDirectory.denyReason(settings.id, userId)) return ack({ ok: false, error: `You are not in #${settings.id}` });
      const to = Array.isArray(payload.to) ? payload.to.filter((t): t is string => typeof t === 'string') : [];
      if (to.length === 0) return ack({ ok: false, error: 'Choose at least one friend' });
      if (to.length > MAX_SHARE_RECIPIENTS) return ack({ ok: false, error: 'Too many people at once' });

      const call = payload.call === true;
      const sent: string[] = [];
      for (const raw of to) {
        const friend = friendModel.friendsOf(userId).find((f) => f.toLowerCase() === raw.toLowerCase());
        if (!friend || roomSettingsModel.isBanned(settings, friend)) continue; // only friends, never banned people
        roomSettingsModel.addMember(settings, friend);
        const key = settings.visibility === 'link' ? settings.key : undefined;
        const online = userModel.find(friend);
        if (online) this.io.to(online.channel).emit('rooms:shared', { from: userId, roomId: settings.id, call, key });
        const query = `${call ? 'call' : 'room'}=${settings.id}${key ? `&key=${key}` : ''}`;
        pushService.notify(friend, {
          type: 'chat',
          title: call ? `${userId} invited you to a call` : `${userId} shared a room`,
          body: call ? `Join the call in #${settings.id}` : `Join #${settings.id}`,
          tag: `share-${settings.id}`,
          url: `/app?${query}`,
        });
        sent.push(friend);
      }
      if (sent.length === 0) return ack({ ok: false, error: 'You can only share with your friends' });
      ack({ ok: true, sent });
      roomDirectory.changed(); // the room now shows up in their Rooms list
    });
  }
}
