import { setTimeout as delay } from 'node:timers/promises';
import { app, isRunning, setLastTickAt, stopRunning } from './app.js';
import config from './config.js';

const server = app.listen(config.port, () => {
  console.log(`crawl-agent listening on port ${config.port}`);
});

const ac = new AbortController();

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Shutting down');
  stopRunning();
  ac.abort();
  server.close(() => process.exit(0));
  setTimeout(() => {
    console.error('Forced exit after timeout');
    process.exit(1);
  }, 10_000).unref();
  process.removeListener('SIGTERM', shutdown);
  process.removeListener('SIGINT', shutdown);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Placeholder tick loop; will be replaced with real scheduling logic.
async function tick() {
  setLastTickAt(Date.now());
}

async function run() {
  while (isRunning()) {
    const start = Date.now();
    try {
      await tick();
    } catch (err) {
      console.error('tick failed:', err);
    }
    const elapsed = Date.now() - start;
    const remainingMs = Math.max(0, config.tickIntervalMs - elapsed);
    try {
      await delay(remainingMs, undefined, { signal: ac.signal });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') break;
      throw err;
    }
  }
}

run().catch((err) => {
  console.error('run loop crashed:', err);
  process.exit(1);
});
