import { isValidUserId, MAX_REQUEST_MESSAGE_LENGTH } from '../../shared/validation';
import { accountModel } from '../models/AccountModel';
import { friendModel } from '../models/FriendModel';
import { userModel } from '../models/UserModel';
import { pushService } from '../services/PushService';
import { roomDirectory } from '../services/RoomDirectory';
import type { AppServer, AppSocket } from '../sockets/types';
import { safeAck } from '../sockets/util';
import type { ChatController } from './ChatController';

/**
 * Friend requests and friend lists. A request must come with a short message; the other
 * person sees it and accepts or declines. Accepting makes them friends and opens their
 * direct-message chat, starting with that message. Anyone can switch on "auto-block
 * incoming friend requests" so nobody can send them new ones.
 */
export class FriendController {
  constructor(
    private readonly io: AppServer,
    private readonly chat: ChatController,
  ) {}

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

      const message = typeof payload.message === 'string' ? payload.message.trim().replace(/\s+\n/g, '\n') : '';
      if (!message) return ack({ ok: false, error: 'Write a short message to go with your request' });
      if (message.length > MAX_REQUEST_MESSAGE_LENGTH) {
        return ack({ ok: false, error: `Keep the message under ${MAX_REQUEST_MESSAGE_LENGTH} characters` });
      }

      // They had already asked us: asking back simply accepts (both messages open the chat).
      if (friendModel.hasRequest(to, me)) {
        this.befriend(to, me, [{ from: to, text: friendModel.requestMessage(to, me) }, { from: me, text: message }]);
        return ack({ ok: true, to, accepted: true });
      }
      // Auto-block is on: the same answer as for anyone, without telling them more.
      if (friendModel.blocksRequests(to)) return ack({ ok: false, error: `${to} isn't accepting friend requests right now` });

      friendModel.addRequest(me, to, message);
      ack({ ok: true, to, accepted: false });
      this.sendState(me, to);
      const target = userModel.find(to);
      if (target) this.io.to(target.channel).emit('friends:requested', { from: me, message });
      pushService.notify(to, {
        type: 'friend',
        title: `${me} wants to be your friend`,
        body: message.length > 120 ? `${message.slice(0, 117)}…` : message,
        tag: `friend-${me}`,
        url: '/app?friends=1',
      });
    });

    socket.on('friends:respond', (payload, rawAck) => {
      const ack = safeAck(rawAck);
      const from = typeof payload?.from === 'string' ? payload.from : '';
      if (!friendModel.hasRequest(from, me)) return ack({ ok: false, error: 'That request is no longer pending' });
      if (payload.accept === true) {
        const requester = accountModel.canonicalId(from) ?? from;
        this.befriend(requester, me, [{ from: requester, text: friendModel.requestMessage(from, me) }]);
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
      this.chat.closeDm(me, other); // no more messages between them
      roomDirectory.changed(); // they no longer see each other's private rooms
    });

    socket.on('friends:block-requests', (payload, rawAck) => {
      const ack = safeAck(rawAck);
      if (typeof payload?.block !== 'boolean') return ack({ ok: false, error: 'Choose on or off' });
      friendModel.setBlockRequests(me, payload.block);
      ack({ ok: true });
      this.sendState(me);
    });
  }

  /** `from` asked, `to` accepted: friends, and their DM opens with the request note(s). */
  private befriend(from: string, to: string, openings: { from: string; text: string }[]): void {
    // Read before addFriends(), which clears the pending requests (and their notes).
    friendModel.addFriends(from, to);
    this.sendState(from, to);
    this.chat.startDm(from, to, openings);
    roomDirectory.changed();
    pushService.notify(from, {
      type: 'friend',
      title: 'Friend request accepted',
      body: `${to} is now your friend. Say hi!`,
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
