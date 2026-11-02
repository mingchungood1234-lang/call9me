import express from 'express';
import path from 'node:path';
import { config } from './config';
import { router } from './routes';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(config.rootDir, 'views'));

  app.use(express.json({ limit: '10kb' }));
  app.use(express.static(path.join(config.rootDir, 'public')));
  app.use(router);
  app.use((_req, res) => {
    res.status(404).send('Not found');
  });

  return app;
}
