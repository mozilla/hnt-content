import express, { type Express } from 'express';
import config from './config.js';

// Why Express in a service that is otherwise a scheduling tick
// loop: the only HTTP endpoint is /healthz, used by the
// Kubernetes liveness probe. We use Express (rather than
// node:http) to stay consistent with content-monorepo, which
// is planned to migrate into this repo. No richer routes are
// planned; if any are added, reconsider wiring
// Sentry.setupExpressErrorHandler.
export const app: Express = express();
app.disable('x-powered-by');

let lastTickAt = 0;
let running = true;

/** Return whether the crawl loop should continue ticking. */
export function isRunning() {
  return running;
}

/** Signal the crawl loop to stop after the current tick. */
export function stopRunning() {
  running = false;
}

export function getLastTickAt() {
  return lastTickAt;
}

export function setLastTickAt(t: number) {
  lastTickAt = t;
}

// K8s liveness probe: a healthy response requires a recent tick, so a
// deadlocked or wedged event loop is detected and the pod is restarted.
app.get('/healthz', (_req, res) => {
  if (lastTickAt === 0) {
    res.status(500).type('text/plain').send('no tick yet');
    return;
  }
  const staleMs = Date.now() - lastTickAt;
  const staleMinutes = staleMs / 60_000;
  if (staleMinutes > config.staleTickThresholdMinutes) {
    res
      .status(500)
      .type('text/plain')
      .send(`last tick ${staleMinutes.toFixed(1)}m ago`);
    return;
  }
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
