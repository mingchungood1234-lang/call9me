import express from 'express';
import path from 'node:path';
import { config } from './config';
import { avatarModel } from './models/AvatarModel';
import { emojiModel } from './models/EmojiModel';
import { router } from './routes';
import { appVersion } from './services/AppVersion';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // Behind HTTPS reverse proxy: lets req.secure see https so the session cookie is Secure.
  app.set('trust proxy', config.trustProxy);
  app.set('view engine', 'ejs');
  app.set('views', path.join(config.rootDir, 'views'));

  app.use(express.json({ limit: '10kb' }));
  app.use(express.static(path.join(config.rootDir, 'public')));
  // Custom emoji pictures; URLs carry ?v=<added at>, so they can be cached for good.
  // Profile pictures: only image files named after a user ID (never the index).
  app.use(
    '/avatars',
    (req, res, next) => (/^\/[a-z][a-z0-9_]{2,19}\.(png|webp|gif)$/.test(req.path) ? next() : res.status(404).end()),
    express.static(avatarModel.dir, {
      immutable: true,
      maxAge: '365d',
      index: false,
      setHeaders: (res) => res.set('X-Content-Type-Options', 'nosniff'),
    }),
  );
  // Only image files are served (never the emoji.json index).
  app.use(
    '/emoji',
    (req, res, next) => (/^\/[a-z0-9_]{2,24}\.(png|webp|gif)$/.test(req.path) ? next() : res.status(404).end()),
    express.static(emojiModel.dir, {
      immutable: true,
      maxAge: '365d',
      index: false,
      setHeaders: (res) => res.set('X-Content-Type-Options', 'nosniff'),
    }),
  );
  // Views tag asset URLs and the page with the build version (cache busting + update checks).
  app.use((_req, res, next) => {
    res.locals.assetVersion = appVersion();
    next();
  });
  app.use(router);
  app.use((_req, res) => {
    res.status(404).send('Not found');
  });

  return app;
}
