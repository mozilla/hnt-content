import { app } from './app.js';

const port = parseInt(process.env.PORT ?? '8080', 10);

const server = app.listen(port, () => {
  console.log(`crawl-worker listening on port ${port}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down');
  server.close();
});
