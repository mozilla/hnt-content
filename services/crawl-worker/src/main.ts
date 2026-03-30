import { app } from './app.js';
import config from './config.js';

const server = app.listen(config.port, () => {
  console.log(`crawl-worker listening on port ${config.port}`);
});

function shutdown() {
  console.log('Shutting down');
  server.close();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
