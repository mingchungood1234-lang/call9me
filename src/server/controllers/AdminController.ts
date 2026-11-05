import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { AdminOverview, AdminRoom, AdminUser } from '../../shared/types';
import { isValidPin, PIN_RULES, PUBLIC_ROOM_ID } from '../../shared/validation';
import { config, isAdmin } from '../config';
import { requestUserId, sessionTokenFrom } from '../middleware/session';
import { accountModel } from '../models/AccountModel';
import { adminLogModel } from '../models/AdminLogModel';
import { avatarModel } from '../models/AvatarModel';
import { callHistoryModel } from '../models/CallHistoryModel';
import { callModel } from '../models/CallModel';
import { friendModel } from '../models/FriendModel';
import { pushSubscriptionModel } from '../models/PushSubscriptionModel';
import { roomModel } from '../models/RoomModel';
import { roomSettingsModel, type RoomSettings } from '../models/RoomSettingsModel';
import { sessionKey, sessionModel } from '../models/SessionModel';
import { stickerModel } from '../models/StickerModel';
import { userChannel, userModel } from '../models/UserModel';
import { userStatusModel } from '../models/UserStatusModel';
import { appVersion } from '../services/AppVersion';
import { allowRequest, clientIp, httpLimits } from '../services/RateLimiter';
import { roomDirectory } from '../services/RoomDirectory';
import type { AppServer } from '../sockets/types';
import { CallController } from './CallController';
import type { ChatController } from './ChatController';

const MIN_PASSCODE_LENGTH = 12;
/** Sent by the dashboard on every request: other sites can't add it, so they can't post here. */
const ADMIN_HEADER = 'x-call9me-admin';
const serverStartedAt = Date.now();
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Whether ADMIN_PASSCODE is set (long enough); without it the dashboard stays locked. */
export function adminPasscodeSet(): boolean {
  return config.adminPasscode.length >= MIN_PASSCODE_LENGTH;
}
if (config.adminPasscode && !adminPasscodeSet()) {
  console.warn(`[admin] ADMIN_PASSCODE is shorter than ${MIN_PASSCODE_LENGTH} characters: the admin dashboard stays locked.`);
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Session key → until when that sign-in has the dashboard unlocked (renewed with use). */
const unlocked = new Map<string, number>();

function fail(res: Response, status: number, error: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ ok: false, error, ...extra });
}

/**
 * The admin dashboard's API. Every request must come from an admin (ADMIN_IDS), from the
 * dashboard itself (a custom header), and — except unlocking — from a sign-in that typed
 * ADMIN_PASSCODE within the last 15 minutes. Every action goes to the audit log.
 */
export class AdminController {
  /** Set once Socket.IO is wired up (see sockets/index.ts). */
  static io: AppServer | null = null;
  static chat: ChatController | null = null;

  /** The signed-in admin, or an error response (and undefined). */
  private static admin(req: Request, res: Response): string | undefined {
    const userId = requestUserId(req);
    if (!userId || !isAdmin(userId)) {
      fail(res, 404, 'Not found');
      return undefined;
    }
    if (req.get(ADMIN_HEADER) !== '1') {
      fail(res, 403, 'Use the admin dashboard');
      return undefined;
    }
    if (!allowRequest(res, httpLimits.adminAction, userId.toLowerCase())) return undefined;
    return userId;
  }

  /** The signed-in admin with the dashboard unlocked (renewing it), or an error response. */
  private static unlockedAdmin(req: Request, res: Response): string | undefined {
    const userId = AdminController.admin(req, res);
    if (!userId) return undefined;
    const key = sessionKey(sessionTokenFrom(req.headers.cookie) ?? '');
    const until = unlocked.get(key) ?? 0;
    if (until <= Date.now()) {
      unlocked.delete(key);
      fail(res, 401, adminPasscodeSet() ? 'Enter the admin passcode' : 'Set ADMIN_PASSCODE in .env first', { locked: true });
      return undefined;
    }
    unlocked.set(key, Date.now() + config.adminUnlockMs);
    return userId;
  }

  /** POST /api/admin/unlock { passcode } */
  static unlock(req: Request, res: Response): void {
    const userId = AdminController.admin(req, res);
    if (!userId) return;
    if (!adminPasscodeSet()) {
      fail(res, 503, `Set ADMIN_PASSCODE (at least ${MIN_PASSCODE_LENGTH} characters) in .env and restart the server.`);
      return;
    }
    if (!allowRequest(res, httpLimits.adminUnlock, clientIp(req))) return;
    if (!allowRequest(res, httpLimits.adminUnlock, `admin:${userId.toLowerCase()}`)) return;
    const passcode = (req.body as { passcode?: unknown } | undefined)?.passcode;
    const right = typeof passcode === 'string' && timingSafeEqual(digest(passcode), digest(config.adminPasscode));
    if (!right) {
      adminLogModel.add(userId, 'unlock-failed', '-', clientIp(req));
      fail(res, 401, 'Wrong passcode');
      return;
    }
    unlocked.set(sessionKey(sessionTokenFrom(req.headers.cookie) ?? ''), Date.now() + config.adminUnlockMs);
    adminLogModel.add(userId, 'unlock', '-', clientIp(req));
    res.json({ ok: true });
  }

  /** POST /api/admin/lock */
  static lock(req: Request, res: Response): void {
    const userId = AdminController.admin(req, res);
    if (!userId) return;
    unlocked.delete(sessionKey(sessionTokenFrom(req.headers.cookie) ?? ''));
    res.json({ ok: true });
  }

  /** GET /api/admin/overview */
  static overview(req: Request, res: Response): void {
    if (!AdminController.unlockedAdmin(req, res)) return;
    const accounts = accountModel.list();
    const online = userModel.all();
    const overview: AdminOverview = {
      online: online.length,
      devices: online.reduce((sum, u) => sum + u.sockets.size, 0),
      accounts: accounts.length,
      suspended: accounts.filter((a) => a.suspended).length,
      locked: accounts.filter((a) => a.lockedUntil > 0).length,
      rooms: roomSettingsModel.all().length,
      calls: callModel.all().map((c) => ({
        id: c.id,
        roomId: c.roomId,
        participants: [...c.participants],
        invited: [...c.invited.keys()],
        startedAt: c.createdAt,
      })),
      serverStartedAt,
      version: appVersion(),
      memoryMb: Math.round(process.memoryUsage().rss / 1_048_576),
    };
    res.json({ ok: true, overview });
  }

  /** GET /api/admin/users */
  static users(req: Request, res: Response): void {
    if (!AdminController.unlockedAdmin(req, res)) return;
    const users: AdminUser[] = accountModel.list().map((a) => ({
      ...a,
      admin: isAdmin(a.id),
      online: userModel.find(a.id)?.sockets.size ?? 0,
      sessions: sessionModel.countFor(a.id),
      pushDevices: pushSubscriptionModel.forUser(a.id).length,
      friends: friendModel.friendsOf(a.id).length,
      rooms: roomModel.followedBy(a.id).length,
      status: userStatusModel.get(a.id),
    }));
    res.json({ ok: true, users });
  }

  /** POST /api/admin/users/:id/:action — sign-out | set-pin { pin } | unlock | suspend | unsuspend | delete { confirm } */
  static async userAction(req: Request<{ id: string; action: string }>, res: Response): Promise<void> {
    const me = AdminController.unlockedAdmin(req, res);
    if (!me) return;
    const id = accountModel.canonicalId(req.params.id);
    if (!id) return fail(res, 404, 'No such user');
    const { action } = req.params;
    const self = same(id, me);
    // Admins are managed in .env: one admin can't lock another out (or take over their PIN).
    if (isAdmin(id) && !self && action !== 'unlock') return fail(res, 403, `${id} is an admin. Manage admins in .env.`);
    if (self && (action === 'suspend' || action === 'delete')) return fail(res, 403, "You can't do that to your own account.");
    const body = (req.body ?? {}) as { pin?: unknown; confirm?: unknown };

    switch (action) {
      case 'sign-out': {
        const count = AdminController.signOutEverywhere(id);
        adminLogModel.add(me, 'sign-out', id, `${count} session(s)`);
        return void res.json({ ok: true, message: `${id} was signed out on ${count} device(s).` });
      }
      case 'set-pin': {
        if (!isValidPin(body.pin)) return fail(res, 400, PIN_RULES);
        await accountModel.setPin(id, body.pin);
        // A forgotten or leaked PIN: whoever is signed in with the old one is signed out.
        const count = self ? 0 : AdminController.signOutEverywhere(id);
        adminLogModel.add(me, 'set-pin', id, count ? `signed out ${count} session(s)` : undefined);
        return void res.json({ ok: true, message: `${id} has a new PIN.${count ? ` Signed out on ${count} device(s).` : ''}` });
      }
      case 'unlock': {
        const was = accountModel.unlock(id);
        adminLogModel.add(me, 'unlock-pin', id);
        return void res.json({ ok: true, message: was ? `${id} can try their PIN again.` : `${id} wasn't locked.` });
      }
      case 'suspend': {
        accountModel.setSuspended(id, true);
        const count = AdminController.signOutEverywhere(id);
        adminLogModel.add(me, 'suspend', id, `${count} session(s) ended`);
        return void res.json({ ok: true, message: `${id} is suspended and was signed out everywhere.` });
      }
      case 'unsuspend': {
        accountModel.setSuspended(id, false);
        adminLogModel.add(me, 'unsuspend', id);
        return void res.json({ ok: true, message: `${id} can sign in again.` });
      }
      case 'delete': {
        if (typeof body.confirm !== 'string' || !same(body.confirm, id)) return fail(res, 400, `Type "${id}" to confirm.`);
        const removedRooms = AdminController.deleteAccount(id, me);
        adminLogModel.add(me, 'delete-user', id, removedRooms.length ? `rooms deleted: ${removedRooms.join(', ')}` : undefined);
        return void res.json({ ok: true, message: `${id} was deleted.` });
      }
      default:
        return fail(res, 404, 'Unknown action');
    }
  }

  /** GET /api/admin/rooms — every room (private and link-only too), plus the Public chat. */
  static rooms(req: Request, res: Response): void {
    if (!AdminController.unlockedAdmin(req, res)) return;
    const messages = (id: string) => {
      const count = roomModel.messagesOf(id).filter((m) => !m.system).length;
      roomModel.release(id); // loaded only to count
      return count;
    };
    const rooms: AdminRoom[] = [
      {
        id: PUBLIC_ROOM_ID,
        owner: '-',
        visibility: 'public-chat',
        createdAt: serverStartedAt,
        members: [],
        banned: [],
        online: roomModel.members(PUBLIC_ROOM_ID),
        messages: messages(PUBLIC_ROOM_ID),
        inCall: 0,
      },
      ...roomSettingsModel
        .all()
        .map((s) => ({
          id: s.id,
          owner: s.owner,
          visibility: s.visibility,
          createdAt: s.createdAt,
          members: AdminController.joinedMembers(s),
          banned: [...(s.banned ?? [])].sort((a, b) => a.localeCompare(b)),
          online: roomModel.members(s.id),
          messages: messages(s.id),
          inCall: callModel.findByRoom(s.id)?.participants.size ?? 0,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    ];
    res.json({ ok: true, rooms });
  }

  /** POST /api/admin/rooms/:id/:action — delete | clear-history | remove-member { userId, ban } | unban { userId } */
  static roomAction(req: Request<{ id: string; action: string }>, res: Response): void {
    const me = AdminController.unlockedAdmin(req, res);
    if (!me) return;
    const chat = AdminController.chat;
    if (!chat) return fail(res, 503, 'The server is still starting');
    const roomId = req.params.id.toLowerCase();
    const { action } = req.params;
    const body = (req.body ?? {}) as { userId?: unknown; ban?: unknown };

    if (action === 'clear-history') {
      if (roomId !== PUBLIC_ROOM_ID && !roomSettingsModel.get(roomId)) return fail(res, 404, 'No such room');
      const count = chat.clearHistory(roomId, me);
      adminLogModel.add(me, 'clear-history', `#${roomId}`, `${count} message(s)`);
      return void res.json({ ok: true, message: `Cleared ${count} message(s) in #${roomId}.` });
    }
    const settings = roomSettingsModel.get(roomId);
    if (!settings) return fail(res, 404, roomId === PUBLIC_ROOM_ID ? 'The Public chat can only be cleared' : 'No such room');
    const target = typeof body.userId === 'string' ? body.userId : '';

    switch (action) {
      case 'delete': {
        const error = chat.deleteRoom(settings, me);
        if (error) return fail(res, 409, error);
        adminLogModel.add(me, 'delete-room', `#${roomId}`, `owner ${settings.owner}`);
        return void res.json({ ok: true, message: `#${roomId} was deleted.` });
      }
      case 'remove-member': {
        const ban = body.ban === true;
        const error = chat.removeMember(settings, target, ban, me);
        if (error) return fail(res, 400, error);
        adminLogModel.add(me, ban ? 'ban-member' : 'remove-member', `#${roomId}`, target);
        return void res.json({ ok: true, message: `${target} was ${ban ? 'banned from' : 'removed from'} #${roomId}.` });
      }
      case 'unban': {
        if (!roomSettingsModel.unban(settings, target)) return fail(res, 400, `${target} isn't banned from #${roomId}`);
        roomDirectory.changed();
        adminLogModel.add(me, 'unban-member', `#${roomId}`, target);
        return void res.json({ ok: true, message: `${target} can join #${roomId} again.` });
      }
      default:
        return fail(res, 404, 'Unknown action');
    }
  }

  /** GET /api/admin/log */
  static log(req: Request, res: Response): void {
    if (!AdminController.unlockedAdmin(req, res)) return;
    res.json({ ok: true, entries: adminLogModel.recent() });
  }

  // ---- Helpers ----

  /** Ends every session of the user and disconnects their open apps. @returns sessions ended. */
  private static signOutEverywhere(userId: string): number {
    const count = sessionModel.destroyAllFor(userId);
    AdminController.io?.in(userChannel(userId)).disconnectSockets(true);
    return count;
  }

  /**
   * Removes an account and what belongs only to it: sessions, notifications, picture,
   * stickers, friendships, call history, room memberships and the rooms it owns (unless a
   * call is going on in one). @returns the deleted rooms.
   */
  private static deleteAccount(id: string, by: string): string[] {
    AdminController.signOutEverywhere(id);
    for (const sub of pushSubscriptionModel.forUser(id)) pushSubscriptionModel.remove(sub.endpoint);
    avatarModel.remove(id);
    for (const sticker of stickerModel.list(id)) stickerModel.remove(id, sticker.id);
    callHistoryModel.clear(id);

    const io = AdminController.io;
    const touched = new Set<string>();
    for (const friend of friendModel.friendsOf(id)) {
      friendModel.removeFriends(id, friend);
      touched.add(friend);
    }
    const { incoming, outgoing } = friendModel.state(id);
    for (const from of incoming) friendModel.removeRequest(from, id) && touched.add(from);
    for (const to of outgoing) friendModel.removeRequest(id, to) && touched.add(to);
    for (const other of touched) io?.to(userChannel(other)).emit('friends:update', friendModel.state(other));

    const deletedRooms: string[] = [];
    for (const settings of roomSettingsModel.all()) {
      if (same(settings.owner, id)) {
        if (!AdminController.chat?.deleteRoom(settings, by)) deletedRooms.push(settings.id);
      } else {
        roomSettingsModel.removeMember(settings, id);
      }
    }
    for (const roomId of roomModel.followedBy(id)) {
      const follower = roomModel.followersOf(roomId).find((f) => same(f, id));
      if (follower) roomModel.unfollow(roomId, follower);
    }

    accountModel.delete(id);
    io?.emit('avatars:update', avatarModel.urls());
    roomDirectory.changed();
    CallController.signaling?.broadcastUsers();
    return deletedRooms;
  }

  private static joinedMembers(settings: RoomSettings): string[] {
    const byKey = new Map<string, string>();
    for (const id of [...(settings.members ?? []), ...roomModel.followersOf(settings.id)]) {
      if (!same(id, settings.owner)) byKey.set(id.toLowerCase(), id);
    }
    return [...byKey.values()].sort((a, b) => a.localeCompare(b));
  }
}
