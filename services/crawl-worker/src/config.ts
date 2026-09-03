export default {
  service: 'crawl-worker',
  port: Number(process.env.PORT ?? '8080'),
  workerRole: process.env.WORKER_ROLE,
};
