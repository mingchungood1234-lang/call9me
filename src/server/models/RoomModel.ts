import { randomUUID } from 'node:crypto';
import type { ChatMessage } from '../../shared/types';
import { config } from '../config';

interface Room {
  id: string;
  members: Set<string>;
  messages: ChatMessage[];
}

/**
 * In-memory public chat rooms. Room IDs are case-insensitive (stored lowercase).
 * A room and its history are discarded once its last member leaves.
 */
export class RoomModel {
  private readonly rooms = new Map<string, Room>();

  normalize(roomId: string): string {
    return roomId.toLowerCase();
  }

  join(roomId: string, userId: string): Room {
    const id = this.normalize(roomId);
    let room = this.rooms.get(id);
    if (!room) {
      room = { id, members: new Set(), messages: [] };
      this.rooms.set(id, room);
    }
    room.members.add(userId);
    return room;
  }

  leave(roomId: string, userId: string): void {
    const id = this.normalize(roomId);
    const room = this.rooms.get(id);
    if (!room) return;
    room.members.delete(userId);
    if (room.members.size === 0) this.rooms.delete(id);
  }

  isMember(roomId: string, userId: string): boolean {
    return this.rooms.get(this.normalize(roomId))?.members.has(userId) ?? false;
  }

  roomsOf(userId: string): string[] {
    return [...this.rooms.values()].filter((r) => r.members.has(userId)).map((r) => r.id);
  }

  members(roomId: string): string[] {
    return [...(this.rooms.get(this.normalize(roomId))?.members ?? [])].sort();
  }

  history(roomId: string): ChatMessage[] {
    return [...(this.rooms.get(this.normalize(roomId))?.messages ?? [])];
  }

  addMessage(roomId: string, from: string, text: string, system = false): ChatMessage {
    const id = this.normalize(roomId);
    const message: ChatMessage = { id: randomUUID(), roomId: id, from, text, timestamp: Date.now(), system };
    const room = this.rooms.get(id);
    if (room) {
      room.messages.push(message);
      if (room.messages.length > config.chatHistoryLimit) room.messages.shift();
    }
    return message;
  }
}

export const roomModel = new RoomModel();
