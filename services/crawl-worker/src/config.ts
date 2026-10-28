import { crawlConfig } from 'crawl-common';

// The following config is read only by the worker. Shared settings come
// from crawl-common or from the package that owns the client.

// Without this value the Pub/Sub names are wrong and the Corpus
// endpoint points at the wrong environment. The chart always sets this
// variable, so an empty value means a missing per-environment override.
if (!crawlConfig.environment) {
  throw new Error('ENVIRONMENT is not set');
}

// The worker image runs as one of two roles, with a Deployment each.
type WorkerRole = 'article' | 'discovery';

/**
 * Return the role this pod runs as, or throw if it is not one of the
 * two. The union return type lets the compiler check the call site.
 */
function requireWorkerRole(value: string | undefined): WorkerRole {
  if (value === 'article' || value === 'discovery') {
    return value;
  }

  throw new Error(
    `WORKER_ROLE must be 'article' or 'discovery', got: ${value ?? '(unset)'}`,
  );
}

// The longest a job can run, rounded up to leave room for publishing:
// four Zyte attempts at the 90s timeout plus backoff (about 6 minutes),
// then five Corpus API attempts at the 30s timeout plus backoff for a
// live article (about 3 minutes).
const MAX_JOB_SECONDS = 600;

export default {
  service: 'crawl-worker',
  port: Number(process.env.PORT ?? '8080'),
  workerRole: requireWorkerRole(process.env.WORKER_ROLE),
  // A worker holds the lock until its job finishes, so the lock must not
  // expire sooner. A crashed worker's lock clears after this long.
  lockTtlSeconds: MAX_JOB_SECONDS,
  // The Pub/Sub client keeps extending the ack deadline for this long, so
  // a slow job keeps its message rather than a copy going to another pod.
  maxExtensionSeconds: MAX_JOB_SECONDS,
  // This caps how many handlers run at once, and so how many Zyte
  // responses are held in memory. The library default of 1000 exhausts
  // the pod memory when the queue is long.
  maxMessages: 64,
  // The discovery worker skips a page crawled within this fraction of
  // pageRefreshMinutes. Without this variable, every second crawl would
  // be skipped, because the time since the last crawl started is always
  // a few seconds less than the interval. At 0.5, a crawl can start up to
  // half an interval late without the next one being skipped.
  minPageRefreshFraction: 0.5,
  // A discovered article carries no refresh window of its own, so this
  // value decides how long the worker leaves it alone. It must not
  // exceed the marker retention in redis-state, or the marker expires
  // first and the check stops working. See docs/crawl/DEDUPLICATION.md.
  discoveredArticleRefreshDays: 30,
  // A failed extraction blocks the next attempt on that URL for this
  // long. Without it one failure repeats across redeliveries and across
  // every page that links the article.
  articleAttemptTtlMinutes: 60,
};
