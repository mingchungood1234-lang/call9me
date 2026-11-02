import type { Request, Response } from 'express';
import type { AvailabilityResponse } from '../../shared/types';
import { isValidUserId, USER_ID_RULES } from '../../shared/validation';
import { accountModel } from '../models/AccountModel';
import { userModel } from '../models/UserModel';
import { listDirectory } from '../services/UserDirectory';

export class UserController {
  /** GET /api/users — currently online users. */
  static list(_req: Request, res: Response): void {
    res.json({ users: listDirectory() });
  }

  /** GET /api/users/:id/availability — whether an ID is valid, registered, and online. */
  static availability(req: Request<{ id: string }>, res: Response<AvailabilityResponse>): void {
    const { id } = req.params;
    if (!isValidUserId(id)) {
      res.json({ valid: false, registered: false, online: false, message: USER_ID_RULES });
      return;
    }
    const registered = accountModel.exists(id);
    const online = userModel.isTaken(id);
    const message = online
      ? 'This ID is signed in right now.'
      : registered
        ? 'Welcome back — enter your PIN.'
        : 'New ID — the PIN you enter now becomes its password.';
    res.json({ valid: true, registered, online, message });
  }
}
