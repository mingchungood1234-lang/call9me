import express from 'express';
import path from 'node:path';
import { config } from './config';
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
