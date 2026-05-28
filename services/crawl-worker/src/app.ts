import * as Sentry from '@sentry/node';
import express, { type Express } from 'express';

export const app: Express = express();
app.disable('x-powered-by');

app.get('/healthz', (_req, res) => {
  res.status(200).type('text/plain').send('ok');
});

// Register before the 404 catch-all: Sentry's request-data
// middleware (url, method, headers, query) only runs for routes
// that call next(), so it has to sit ahead of the catch-all to
// reach normal traffic.
Sentry.setupExpressErrorHandler(app);

app.use((_req: express.Request, res: express.Response) => {
  res.status(404).type('text/plain').send('not found');
});

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error('Unhandled error:', err.stack || err);
    res.status(500).type('text/plain').send('internal server error');
  },
);
