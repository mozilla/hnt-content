import * as Sentry from '@sentry/node';

// Match Sentry's SDK default of 2s. Leaves most of the pod's 10s
// SIGTERM window for application shutdown and Pub/Sub drain.
const FLUSH_TIMEOUT_MS = 2_000;

/**
 * Flush pending Sentry events and disable the SDK. Logs a warning
 * if the flush times out (events dropped). Call once on SIGTERM
 * after other shutdown work.
 */
export async function shutdownSentry(): Promise<void> {
  const flushed = await Sentry.close(FLUSH_TIMEOUT_MS);
  if (!flushed) {
    console.error('Sentry shutdown timed out; events may be lost');
  }
}
