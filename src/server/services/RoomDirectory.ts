import type { RoomSummary } from '../../shared/types';
import { callModel } from '../models/CallModel';
import { friendModel } from '../models/FriendModel';
import { roomModel } from '../models/RoomModel';
import { roomSettingsModel, type RoomSettings } from '../models/RoomSettingsModel';
import { userModel } from '../models/UserModel';
import { userStatusModel } from '../models/UserStatusModel';
import type { AppServer } from '../sockets/types';

const BROADCAST_DELAY_MS = 250;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The Rooms directory and room access rules. A room ID covers both its chat and its
 * call. Public rooms are listed for everyone; private ones only for the owner and the
 * owner's friends; "link" rooms only for people who joined through the invite link.
 * Sharing a room with a friend lets them in, whatever its visibility.
 */
export class RoomDirectory {
  private io: AppServer | null = null;
  private timer: NodeJS.Timeout | null = null;

  init(io: AppServer): void {
    this.io = io;
    // "link" rooms are permanent: their chat history is kept on disk.
    roomModel.isPermanent = (roomId) => roomSettingsModel.get(roomId)?.visibility === 'link';
  }

  /** Listed for (and free to join): everyone if public; the owner, members (shared with / joined by link) and, if private, the owner's friends. */
  canSee(settings: RoomSettings, userId: string): boolean {
    if (settings.visibility === 'public' || same(settings.owner, userId)) return true;
    if (roomSettingsModel.isMember(settings, userId)) return true;
    return settings.visibility === 'private' && friendModel.areFriends(settings.owner, userId);
  }

  /**
   * @returns null if `userId` may enter the room (chat or call), else why not. The right
   * `key` (from an invite link) lets anyone into a "link" room and makes them a member.
   */
  denyReason(roomId: string, userId: string, key?: unknown): string | null {
    const settings = roomSettingsModel.get(roomId);
    if (!settings || this.canSee(settings, userId)) return null;
    if (settings.visibility === 'link' && settings.key && key === settings.key) {
      roomSettingsModel.addMember(settings, userId);
      this.changed();
      return null;
    }
    // Already inside (e.g. it was made private after they joined), or called into it.
    const call = callModel.findByRoom(roomId);
    if (roomModel.isMember(roomId, userId) || call?.participants.has(userId) || call?.invited.has(userId)) return null;
    return settings.visibility === 'link'
      ? `#${settings.id} is invite-only. Ask someone in it for the invite link.`
      : `#${settings.id} is private. Only ${settings.owner}'s friends can join.`;
  }

  summary(settings: RoomSettings): RoomSummary {
    const call = callModel.findByRoom(settings.id);
    const online = new Set(
      [...roomModel.members(settings.id), ...(call?.participants ?? [])].filter(
        (id) => userStatusModel.get(id) !== 'invisible', // invisible users don't show up in the directory
      ),
    );
    return {
      id: settings.id,
      owner: settings.owner,
      visibility: settings.visibility,
      online: [...online].sort((a, b) => a.localeCompare(b)),
      inCall: call?.participants.size ?? 0,
      followers: roomModel.followersOf(settings.id).length,
      // Only ever sent to people allowed in (see listFor), so they can share the link on.
      key: settings.visibility === 'link' ? settings.key : undefined,
    };
  }

  /** Rooms `userId` can see that are alive (someone inside or following), plus their own and permanent ones. */
  listFor(userId: string): RoomSummary[] {
    return roomSettingsModel
      .all()
      .filter((s) => this.canSee(s, userId))
      .map((s) => this.summary(s))
      .filter((r) => r.online.length > 0 || r.followers > 0 || r.visibility === 'link' || same(r.owner, userId))
      .sort((a, b) => b.online.length - a.online.length || b.followers - a.followers || a.id.localeCompare(b.id));
  }

  sendTo(userId: string): void {
    const user = userModel.find(userId);
    if (user && this.io) this.io.to(user.socketId).emit('rooms:update', this.listFor(user.id));
  }

  /** Re-sends everyone their list soon (bursts of joins/leaves are coalesced). */
  changed(): void {
    if (this.timer || !this.io) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      for (const user of userModel.all()) this.sendTo(user.id);
    }, BROADCAST_DELAY_MS);
  }
}

export const roomDirectory = new RoomDirectory();
