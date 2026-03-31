import { app } from './app.js';
import config from './config.js';

const server = app.listen(config.port, () => {
  console.log(`crawl-worker listening on port ${config.port}`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Shutting down');
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
