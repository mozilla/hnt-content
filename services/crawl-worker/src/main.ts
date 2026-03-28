import { app } from './app.js';
import config from './config.js';

const server = app.listen(config.port, () => {
  console.log(`crawl-worker listening on port ${config.port}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down');
  server.close();
});
