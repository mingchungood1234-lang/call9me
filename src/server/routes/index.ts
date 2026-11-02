import { Router } from 'express';
import path from 'node:path';
import { config } from '../config';
import { AuthController } from '../controllers/AuthController';
import { CallController } from '../controllers/CallController';
import { PageController } from '../controllers/PageController';
import { PushController } from '../controllers/PushController';
import { UserController } from '../controllers/UserController';

export const router = Router();

// Views
router.get('/', PageController.landing);
router.get('/app', PageController.app);

// The service worker must be served from the root so its scope covers the whole site.
router.get('/sw.js', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(config.rootDir, 'public', 'js', 'sw.js'));
});

// JSON API
router.post('/api/login', AuthController.login);
router.post('/api/logout', AuthController.logout);
router.get('/api/users', UserController.list);
router.get('/api/users/:id/availability', UserController.availability);
router.post('/api/calls/:callId/decline', CallController.decline);
router.get('/api/push/key', PushController.publicKey);
router.post('/api/push/subscribe', PushController.subscribe);
router.post('/api/push/unsubscribe', PushController.unsubscribe);
