import { isValidUserId } from '../../shared/validation';
import { accountModel } from '../models/AccountModel';
import { friendModel } from '../models/FriendModel';
import { userModel } from '../models/UserModel';
import { pushService } from '../services/PushService';
import { roomDirectory } from '../services/RoomDirectory';
import type { AppServer, AppSocket } from '../sockets/types';
import { safeAck } from '../sockets/util';

/** Friend requests (the other person must accept) and friend lists. */
export class FriendController {
  constructor(private readonly io: AppServer) {}

  register(socket: AppSocket): void {
    const me = socket.data.userId;
    this.sendState(me);

    socket.on('friends:request', (payload, rawAck) => {
      const ack = safeAck(rawAck);
      const to = isValidUserId(payload?.to) ? accountModel.canonicalId(payload.to) : undefined;
      if (!to) return ack({ ok: false, error: `There is no user "${String(payload?.to ?? '')}"` });
      if (to.toLowerCase() === me.toLowerCase()) return ack({ ok: false, error: 'You cannot add yourself' });
      if (friendModel.areFriends(me, to)) return ack({ ok: false, error: `${to} is already your friend` });
      if (friendModel.hasRequest(me, to)) return ack({ ok: false, error: `You already asked ${to}; waiting for them to accept` });

      // They had already asked us: adding them back simply accepts.
      if (friendModel.hasRequest(to, me)) {
        this.befriend(to, me);
        return ack({ ok: true, to, accepted: true });
      }
      friendModel.addRequest(me, to);
      ack({ ok: true, to, accepted: false });
      this.sendState(me, to);
      const target = userModel.find(to);
      if (target) this.io.to(target.channel).emit('friends:requested', { from: me });
      pushService.notify(to, {
        type: 'friend',
        title: 'Friend request',
        body: `${me} wants to be your friend`,
        tag: `friend-${me}`,
        url: '/app?friends=1',
      });
    });

    socket.on('friends:respond', (payload, rawAck) => {
      const ack = safeAck(rawAck);
      const from = typeof payload?.from === 'string' ? payload.from : '';
      if (!friendModel.hasRequest(from, me)) return ack({ ok: false, error: 'That request is no longer pending' });
      if (payload.accept === true) {
        this.befriend(from, me);
      } else {
        friendModel.removeRequest(from, me);
        this.sendState(me, from);
      }
      ack({ ok: true });
    });

    socket.on('friends:cancel', (payload, rawAck) => {
      const ack = safeAck(rawAck);
      const to = typeof payload?.to === 'string' ? payload.to : '';
      if (!friendModel.removeRequest(me, to)) return ack({ ok: false, error: 'That request is no longer pending' });
      ack({ ok: true });
      this.sendState(me, to);
    });

    socket.on('friends:remove', (payload, rawAck) => {
      const ack = safeAck(rawAck);
      const other = typeof payload?.id === 'string' ? payload.id : '';
      if (!friendModel.removeFriends(me, other)) return ack({ ok: false, error: `${other} is not your friend` });
      ack({ ok: true });
      this.sendState(me, other);
      roomDirectory.changed(); // they no longer see each other's private rooms
    });
  }

  /** `from` asked, `to` accepted. */
  private befriend(from: string, to: string): void {
    friendModel.addFriends(from, to);
    this.sendState(from, to);
    roomDirectory.changed();
    pushService.notify(from, {
      type: 'friend',
      title: 'Friend request accepted',
      body: `${to} is now your friend`,
      tag: `friend-${to}`,
      url: '/app?friends=1',
    });
  }

  private sendState(...userIds: string[]): void {
    for (const id of userIds) {
      const user = userModel.find(id);
      if (user) this.io.to(user.channel).emit('friends:update', friendModel.state(user.id));
    }
  }
}
