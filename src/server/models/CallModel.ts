import { randomUUID } from 'node:crypto';

export interface PendingInvite {
  /** Who sent the invite. */
  by: string;
  at: number;
}

export interface Call {
  id: string;
  /**
   * Room ID for call rooms (anyone with the ID can join, the call stays open while
   * anyone is in it). Null for invite-only calls, which end when one person is left.
   */
  roomId: string | null;
  /** Video or voice call; invitees join in the same mode. */
  video: boolean;
  /** User IDs connected to the call (full mesh: everyone links to everyone). */
  participants: Set<string>;
  /** User IDs that are ringing and haven't answered yet. */
  invited: Map<string, PendingInvite>;
  /** People who left a moment ago → until when they may rejoin (the call stays open for them). */
  recent: Map<string, number>;
  createdAt: number;
}

/** In-memory group call sessions. Room IDs are case-insensitive (stored lowercase). */
export class CallModel {
  private readonly calls = new Map<string, Call>();
  /** roomId → callId */
  private readonly rooms = new Map<string, string>();

  normalizeRoomId(roomId: string): string {
    return roomId.toLowerCase();
  }

  create(ownerId: string, video: boolean, roomId: string | null = null): Call {
    const call: Call = {
      id: randomUUID(),
      roomId: roomId === null ? null : this.normalizeRoomId(roomId),
      video,
      participants: new Set([ownerId]),
      invited: new Map(),
      recent: new Map(),
      createdAt: Date.now(),
    };
    this.calls.set(call.id, call);
    if (call.roomId) this.rooms.set(call.roomId, call.id);
    return call;
  }

  get(id: string | null | undefined): Call | undefined {
    return id ? this.calls.get(id) : undefined;
  }

  findByRoom(roomId: string): Call | undefined {
    return this.get(this.rooms.get(this.normalizeRoomId(roomId)));
  }

  delete(id: string): void {
    const call = this.calls.get(id);
    if (call?.roomId && this.rooms.get(call.roomId) === id) this.rooms.delete(call.roomId);
    this.calls.delete(id);
  }

  /** The call currently ringing this user (online or offline), if any. */
  findInviteFor(userId: string): Call | undefined {
    for (const call of this.calls.values()) if (call.invited.has(userId)) return call;
    return undefined;
  }

  /** The call this user left a moment ago and may still rejoin, if any. */
  findRejoinFor(userId: string): Call | undefined {
    for (const call of this.calls.values()) if (call.recent.has(userId)) return call;
    return undefined;
  }

  /** Participants plus people still ringing; used to enforce the size limit. */
  size(call: Call): number {
    return call.participants.size + call.invited.size;
  }
}

export const callModel = new CallModel();
