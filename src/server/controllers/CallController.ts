import type { Request, Response } from 'express';
import { requestUserId } from '../middleware/session';
import type { SignalingController } from './SignalingController';

/** HTTP actions on calls, for when the app isn't open (e.g. a notification's Decline button). */
export class CallController {
  /** Set once Socket.IO is wired up (see sockets/index.ts). */
  static signaling: SignalingController | null = null;

  /** POST /api/calls/:callId/decline — requires a session (the service worker sends the cookie). */
  static decline(req: Request<{ callId: string }>, res: Response): void {
    const userId = requestUserId(req);
    if (!userId) {
      res.status(401).json({ ok: false, error: 'Not signed in' });
      return;
    }
    const declined = CallController.signaling?.declineInvite(userId, req.params.callId, 'declined') ?? false;
    res.json({ ok: declined });
  }
}
