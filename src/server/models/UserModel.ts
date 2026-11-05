import type { OnlineUserSummary, Presence } from '../../shared/types';
import { config } from '../config';
import { userStatusModel } from './UserStatusModel';

/** The Socket.IO room that all of a user's open devices are in: emitting to it reaches every one. */
export function userChannel(id: string): string {
  return `user:${id.toLowerCase()}`;
}

export interface OnlineUser {
  id: string;
  /** Emit here to reach all of this user's devices (see `userChannel`). */
  channel: string;
  /** Socket IDs of the devices (app tabs) signed in right now. */
  sockets: Set<string>;
  /** The call this user is connected to. */
  callId: string | null;
  /** The one device that's in `callId`: the call's signaling goes only there. */
  callSocketId: string | null;
  /** A call this user is being invited to (ringing on all their devices). */
  invitedTo: string | null;
  /** Devices whose app is on screen (reported by the page); no push notifications are sent while any is. */
  visibleSockets: Set<string>;
  connectedAt: number;
}

/**
 * In-memory registry of connected users, each with one or more devices.
 * IDs are unique case-insensitively; the original casing is kept for display.
 */
export class UserModel {
  private readonly users = new Map<string, OnlineUser>();

  private key(id: string): string {
    return id.toLowerCase();
  }

  /** Online on at least one device. */
  isTaken(id: string): boolean {
    return this.users.has(this.key(id));
  }

  /** Adds a device. @returns null if this ID already has as many devices as allowed. */
  add(id: string, socketId: string): OnlineUser | null {
    let user = this.users.get(this.key(id));
    if (user && user.sockets.size >= config.maxDevicesPerUser) return null;
    if (!user) {
      user = {
        id,
        channel: userChannel(id),
        sockets: new Set(),
        callId: null,
        callSocketId: null,
        invitedTo: null,
        visibleSockets: new Set(),
        connectedAt: Date.now(),
      };
      this.users.set(this.key(id), user);
    }
    user.sockets.add(socketId);
    return user;
  }

  /** Removes a device. @returns whether that was the user's last one (they're offline now). */
  removeSocket(id: string, socketId: string): boolean {
    const user = this.users.get(this.key(id));
    if (!user) return false;
    user.sockets.delete(socketId);
    user.visibleSockets.delete(socketId);
    if (user.sockets.size > 0) return false;
    this.users.delete(this.key(id));
    return true;
  }

  find(id: string): OnlineUser | undefined {
    return this.users.get(this.key(id));
  }

  /** The app is on screen on one of their devices. */
  isVisible(id: string): boolean {
    return (this.find(id)?.visibleSockets.size ?? 0) > 0;
  }

  isBusy(user: OnlineUser): boolean {
    return user.callId !== null || user.invitedTo !== null;
  }

  /** Where a call's signaling for this user goes: the device in the call, else all of them. */
  callTarget(user: OnlineUser): string {
    return user.callSocketId ?? user.channel;
  }

  /** Every connected user. */
  all(): OnlineUser[] {
    return [...this.users.values()];
  }

  /** Everyone publicly online, as others see them (invisible users are left out). */
  list(): OnlineUserSummary[] {
    return [...this.users.values()]
      .filter((u) => userStatusModel.get(u.id) !== 'invisible')
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((u) => ({ id: u.id, presence: this.presenceOf(u) }));
  }

  /** Do not disturb wins over "in a call", which wins over idle. */
  private presenceOf(user: OnlineUser): Presence {
    const status = userStatusModel.get(user.id);
    if (status === 'dnd') return 'dnd';
    if (this.isBusy(user)) return 'busy';
    return status === 'idle' ? 'idle' : 'available';
  }
}

export const userModel = new UserModel();
