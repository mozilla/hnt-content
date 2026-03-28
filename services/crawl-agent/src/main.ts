import { app, isRunning, setLastTickAt, stopRunning } from './app.js';
import config from './config.js';

const server = app.listen(config.port, () => {
  console.log(`crawl-agent listening on port ${config.port}`);
});

let sleepTimer: ReturnType<typeof setTimeout> | undefined;

function shutdown() {
  console.log('Shutting down');
  stopRunning();
  if (sleepTimer) clearTimeout(sleepTimer);
  server.close();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Placeholder tick loop; will be replaced with real scheduling logic.
async function tick() {
  setLastTickAt(Date.now());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    sleepTimer = setTimeout(resolve, ms);
  });
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
    await sleep(remainingMs);
  }
}

run();
