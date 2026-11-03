import type { OnlineUserSummary, Presence } from '../../shared/types';
import { userStatusModel } from './UserStatusModel';

export interface OnlineUser {
  id: string;
  socketId: string;
  /** The call this user is connected to. */
  callId: string | null;
  /** A call this user is being invited to (ringing). */
  invitedTo: string | null;
  /** The app is on screen (reported by the page); no push notifications are sent then. */
  visible: boolean;
  connectedAt: number;
}

/**
 * In-memory registry of connected users.
 * IDs are unique case-insensitively; the original casing is kept for display.
 */
export class UserModel {
  private readonly users = new Map<string, OnlineUser>();

  private key(id: string): string {
    return id.toLowerCase();
  }

  isTaken(id: string): boolean {
    return this.users.has(this.key(id));
  }

  add(id: string, socketId: string): OnlineUser | null {
    if (this.isTaken(id)) return null;
    const user: OnlineUser = { id, socketId, callId: null, invitedTo: null, visible: false, connectedAt: Date.now() };
    this.users.set(this.key(id), user);
    return user;
  }

  remove(id: string): void {
    this.users.delete(this.key(id));
  }

  find(id: string): OnlineUser | undefined {
    return this.users.get(this.key(id));
  }

  isBusy(user: OnlineUser): boolean {
    return user.callId !== null || user.invitedTo !== null;
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
