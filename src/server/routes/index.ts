import { Router } from 'express';
import path from 'node:path';
import { config } from '../config';
import { AdminController } from '../controllers/AdminController';
import { AuthController } from '../controllers/AuthController';
import { CallController } from '../controllers/CallController';
import { GoogleAuthController } from '../controllers/GoogleAuthController';
import { PageController } from '../controllers/PageController';
import { PairingController } from '../controllers/PairingController';
import { PinResetController } from '../controllers/PinResetController';
import { PushController } from '../controllers/PushController';
import { UserController } from '../controllers/UserController';
import { appVersion } from '../services/AppVersion';

export const router = Router();

// Views
router.get('/', PageController.landing);
router.get('/app', PageController.app);
router.get('/admin', PageController.admin);
router.get('/reset-pin', PageController.resetPin);

// The service worker must be served from the root so its scope covers the whole site.
router.get('/sw.js', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(config.rootDir, 'public', 'js', 'sw.js'));
});

// "Continue with Google" (only works when GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are set)
router.get('/auth/google', GoogleAuthController.start);
router.get('/auth/google/callback', GoogleAuthController.callback);

// JSON API
router.post('/api/login', AuthController.login);
router.post('/api/google/complete', GoogleAuthController.complete);
router.post('/api/logout', AuthController.logout);
// "Forgot PIN?": a reset link by email (only when SMTP and PUBLIC_URL are set)
router.post('/api/forgot-pin', PinResetController.forgot);
router.post('/api/reset-pin', PinResetController.reset);
router.get('/api/account/recovery-email', PinResetController.get);
router.post('/api/account/recovery-email', PinResetController.set);
router.post('/api/pair/start', PairingController.start);
router.get('/api/pair/status', PairingController.status);
router.post('/api/pair/info', PairingController.info);
router.post('/api/pair/approve', PairingController.approve);
router.get('/api/version', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ version: appVersion() });
});
// Admin dashboard: admins only, unlocked with ADMIN_PASSCODE.
router.post('/api/admin/unlock', AdminController.unlock);
router.post('/api/admin/lock', AdminController.lock);
router.get('/api/admin/overview', AdminController.overview);
router.get('/api/admin/users', AdminController.users);
router.post('/api/admin/users/:id/:action', AdminController.userAction);
router.get('/api/admin/rooms', AdminController.rooms);
router.post('/api/admin/rooms/:id/:action', AdminController.roomAction);
router.get('/api/admin/log', AdminController.log);
router.get('/api/users', UserController.list);
router.get('/api/users/:id/availability', UserController.availability);
router.post('/api/calls/:callId/decline', CallController.decline);
router.get('/api/push/key', PushController.publicKey);
router.post('/api/push/subscribe', PushController.subscribe);
router.post('/api/push/unsubscribe', PushController.unsubscribe);
router.post('/api/push/test', PushController.test);
