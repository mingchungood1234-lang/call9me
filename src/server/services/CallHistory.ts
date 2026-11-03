import { randomUUID } from 'node:crypto';
import type { CallHistoryEntry, CallOutcome } from '../../shared/types';
import { callHistoryModel } from '../models/CallHistoryModel';
import type { Call } from '../models/CallModel';

interface OpenRecord {
  userId: string;
  entry: Omit<CallHistoryEntry, 'outcome' | 'endedAt' | 'durationMs'>;
  /** In the call (accepted, joined, or started it), not just ringing. */
  joined: boolean;
  /** When someone else was first connected alongside us. */
  connectedAt: number | null;
  /** Someone we called declined (vs. simply not answering). */
  declinedByPeer: boolean;
}

/**
 * Follows each user's view of a call from ring/dial to its end and stores the result in
 * the call history. Records live in memory until the call ends for that user.
 */
export class CallHistory {
  /** "callId|userid" → open record */
  private readonly open = new Map<string, OpenRecord>();

  /** Called with every finished entry (to push it to the user's app). */
  onEntry: (userId: string, entry: CallHistoryEntry) => void = () => {};

  private key(callId: string, userId: string): string {
    return `${callId}|${userId.toLowerCase()}`;
  }

  private ensure(call: Call, userId: string, direction: CallHistoryEntry['direction'], video: boolean): OpenRecord {
    const key = this.key(call.id, userId);
    let record = this.open.get(key);
    if (!record) {
      record = {
        userId,
        entry: { id: randomUUID(), callId: call.id, direction, roomId: call.roomId, peers: [], video, startedAt: Date.now() },
        joined: false,
        connectedAt: null,
        declinedByPeer: false,
      };
      this.open.set(key, record);
    }
    return record;
  }

  private addPeer(record: OpenRecord | undefined, peerId: string): void {
    if (record && peerId !== record.userId && !record.entry.peers.includes(peerId)) record.entry.peers.push(peerId);
  }

  /** `callerId` (already in `call`) rings `calleeId`. */
  dial(call: Call, callerId: string, calleeId: string, video: boolean): void {
    const caller = this.ensure(call, callerId, call.roomId ? 'room' : 'outgoing', video);
    caller.joined = true;
    this.addPeer(caller, calleeId);

    const callee = this.ensure(call, calleeId, 'incoming', call.video);
    this.addPeer(callee, callerId);
    for (const id of call.participants) this.addPeer(callee, id);
  }

  /** `userId` has just been added to `call.participants` (accepted, or joined a room). */
  join(call: Call, userId: string, video: boolean): void {
    const record = this.ensure(call, userId, call.roomId ? 'room' : 'incoming', video);
    record.joined = true;
    record.entry.video = video;
    const now = Date.now();
    for (const id of call.participants) {
      if (id === userId) continue;
      this.addPeer(record, id);
      const other = this.open.get(this.key(call.id, id));
      this.addPeer(other, userId);
      if (other && other.connectedAt === null) other.connectedAt = now;
    }
    if (call.participants.size > 1 && record.connectedAt === null) record.connectedAt = now;
  }

  /** `userId` declined `call`; the others note it so their entry can say "Declined". */
  declined(call: Call, userId: string): void {
    for (const id of call.participants) {
      const record = this.open.get(this.key(call.id, id));
      if (record && record.entry.peers.includes(userId)) record.declinedByPeer = true;
    }
  }

  /**
   * The call is over for `userId`. `fallback` is the outcome when nobody was ever
   * connected with them (e.g. "missed" for an invite that timed out).
   */
  finish(callId: string, userId: string, fallback: CallOutcome): void {
    const key = this.key(callId, userId);
    const record = this.open.get(key);
    if (!record) return;
    this.open.delete(key);

    const endedAt = Date.now();
    let outcome: CallOutcome = fallback;
    if (record.connectedAt !== null) outcome = 'completed';
    else if (record.joined && record.declinedByPeer && fallback === 'unanswered') outcome = 'declined';
    // Nobody "answers" a room: leaving one that nobody else joined isn't a cancelled call.
    else if (record.entry.direction === 'room' && fallback === 'cancelled') outcome = 'unanswered';
    const entry: CallHistoryEntry = {
      ...record.entry,
      outcome,
      endedAt,
      durationMs: record.connectedAt !== null ? endedAt - record.connectedAt : 0,
    };
    callHistoryModel.add(record.userId, entry);
    this.onEntry(record.userId, entry);
  }
}

export const callHistory = new CallHistory();
