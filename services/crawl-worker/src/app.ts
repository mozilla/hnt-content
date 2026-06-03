import express, { type Express } from 'express';

// Why Express in a service that is otherwise Pub/Sub-only: the
// only HTTP endpoint is /healthz, used by the Kubernetes
// liveness probe. We use Express (rather than node:http) to
// stay consistent with content-monorepo, which is planned to
// migrate into this repo. No richer routes are planned; if any
// are added, reconsider wiring Sentry.setupExpressErrorHandler.
export const app: Express = express();
app.disable('x-powered-by');

app.get('/healthz', (_req, res) => {
  res.status(200).type('text/plain').send('ok');
});

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
