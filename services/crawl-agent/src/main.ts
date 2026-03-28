import { app, isRunning, setLastTickAt, stopRunning } from './app.js';

const port = parseInt(process.env.PORT ?? '8080', 10);

const server = app.listen(port, () => {
  console.log(`crawl-agent listening on port ${port}`);
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
    try {
      await tick();
    } catch (err) {
      console.error('tick failed:', err);
    }
    await sleep(60_000);
  }
}

run();
