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

// This value must match ack_deadline_seconds on the subscriptions in
// hnt/tf/modules/pubsub. Pub/Sub redelivers a message about this long
// after a worker stops acknowledging it.
const ACK_DEADLINE_SECONDS = 300;

// Subtracting this margin clears the lock just before redelivery, so
// the next worker can take a lock that a stopped worker still holds.
const LOCK_TTL_ACK_SECONDS_DELTA = 30;

export default {
  service: 'crawl-worker',
  port: Number(process.env.PORT ?? '8080'),
  workerRole: requireWorkerRole(process.env.WORKER_ROLE),
  ackDeadlineSeconds: ACK_DEADLINE_SECONDS,
  lockTtlSeconds: ACK_DEADLINE_SECONDS - LOCK_TTL_ACK_SECONDS_DELTA,
  // Article extraction takes well under two minutes, so a cap below the
  // ack deadline releases a stuck message sooner.
  maxExtensionSeconds: ACK_DEADLINE_SECONDS - LOCK_TTL_ACK_SECONDS_DELTA,
  // This caps how many handlers run at once, and so how many Zyte
  // responses are held in memory. The library default of 1000 exhausts
  // the pod memory when the queue is long.
  maxMessages: 64,
  // A discovered article carries no refresh window of its own, so this
  // value decides how long the worker leaves it alone. The refresh
  // windows are described in docs/crawl/DEDUPLICATION.md.
  discoveredArticleRefreshDays: Number(
    process.env.DISCOVERED_ARTICLE_REFRESH_DAYS ?? '30',
  ),
  // A failed extraction blocks the next attempt on that URL for this
  // long. Without it one failure repeats across redeliveries and across
  // every page that links the article.
  articleAttemptTtlMinutes: Number(
    process.env.ARTICLE_ATTEMPT_TTL_MINUTES ?? '60',
  ),
};
