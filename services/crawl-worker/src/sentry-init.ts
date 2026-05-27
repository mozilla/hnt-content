import { initSentry } from 'crawl-common';

// WORKER_ROLE distinguishes the article vs discovery worker (same
// image, same code, different subscription). Helm sets it per pod;
// missing in any deployed env is a misconfiguration we'd rather
// fail fast on than ship Sentry events without the role tag.
const workerRole = process.env.WORKER_ROLE;
if (workerRole !== 'article' && workerRole !== 'discovery') {
  throw new Error(
    `WORKER_ROLE must be 'article' or 'discovery' (got ${JSON.stringify(workerRole)})`,
  );
}

initSentry({ service: 'crawl-worker', workerRole });
