import type { Request, Response } from 'express';
import type { LoginResponse } from '../../shared/types';
import { isValidPin, isValidUserId, PIN_RULES, USER_ID_RULES } from '../../shared/validation';
import { SESSION_COOKIE, sessionTokenFrom, setSessionCookie } from '../middleware/session';
import { accountModel } from '../models/AccountModel';
import { sessionModel } from '../models/SessionModel';
import { allowRequest, clientIp, httpLimits } from '../services/RateLimiter';

export class AuthController {
  /** POST /api/login { id, pin } — signs in, or registers the ID on first use. */
  static async login(req: Request, res: Response<LoginResponse>): Promise<void> {
    const { id, pin } = (req.body ?? {}) as { id?: unknown; pin?: unknown };
    if (!isValidUserId(id)) {
      res.status(400).json({ ok: false, error: `Invalid ID. ${USER_ID_RULES}` });
      return;
    }
    if (!isValidPin(pin)) {
      res.status(400).json({ ok: false, error: PIN_RULES });
      return;
    }
    const ip = clientIp(req);
    if (!allowRequest(res, httpLimits.login, ip)) return;
    if (!accountModel.exists(id) && !allowRequest(res, httpLimits.signup, ip)) return;

    const result = await accountModel.login(id, pin);
    if (!result.ok) {
      res.status(401).json(result);
      return;
    }

    sessionModel.destroy(sessionTokenFrom(req.headers.cookie));
    setSessionCookie(req, res, sessionModel.create(result.id));
    res.json({ ok: true, userId: result.id, created: result.created });
  }

  /**
   * POST /api/logout. Joined rooms stay joined; the app removes this device's push
   * subscription first, so its notifications stop anyway.
   */
  static logout(req: Request, res: Response): void {
    sessionModel.destroy(sessionTokenFrom(req.headers.cookie));
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  }
}
