import type { Request, Response } from 'express';
import type { LoginResponse } from '../../shared/types';
import { isValidPin, isValidUserId, PIN_RULES, USER_ID_RULES } from '../../shared/validation';
import { config } from '../config';
import { SESSION_COOKIE, sessionTokenFrom } from '../middleware/session';
import { accountModel } from '../models/AccountModel';
import { sessionModel } from '../models/SessionModel';
import { userModel } from '../models/UserModel';

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

    const result = await accountModel.login(id, pin);
    if (!result.ok) {
      res.status(401).json(result);
      return;
    }
    if (userModel.isTaken(result.id)) {
      res.status(409).json({ ok: false, error: 'This ID is already signed in on another tab or device.' });
      return;
    }

    sessionModel.destroy(sessionTokenFrom(req.headers.cookie));
    res.cookie(SESSION_COOKIE, sessionModel.create(result.id), {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: config.sessionTtlMs,
      path: '/',
    });
    res.json({ ok: true, userId: result.id, created: result.created });
  }

  /** POST /api/logout */
  static logout(req: Request, res: Response): void {
    sessionModel.destroy(sessionTokenFrom(req.headers.cookie));
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  }
}
