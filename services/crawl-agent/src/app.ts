import express, { type Express } from 'express';
import config from './config.js';

export const app: Express = express();
app.disable('x-powered-by');

let lastTickAt = 0;
let running = true;

export function isRunning() {
  return running;
}

export function stopRunning() {
  running = false;
}

export function getLastTickAt() {
  return lastTickAt;
}

export function setLastTickAt(t: number) {
  lastTickAt = t;
}

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
    console.error('Unhandled error:', err.message);
    res.status(500).type('text/plain').send('internal server error');
  },
);
