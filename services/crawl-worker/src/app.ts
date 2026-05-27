import * as Sentry from '@sentry/node';
import express, { type Express } from 'express';

export const app: Express = express();
app.disable('x-powered-by');

app.get('/healthz', (_req, res) => {
  res.status(200).type('text/plain').send('ok');
});

app.use((_req: express.Request, res: express.Response) => {
  res.status(404).type('text/plain').send('not found');
});

// Sentry's error handler captures the error then calls next(), so
// the user handler below still owns the response.
Sentry.setupExpressErrorHandler(app);

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
