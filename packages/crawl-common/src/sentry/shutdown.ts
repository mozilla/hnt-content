import * as Sentry from '@sentry/node';

// Two seconds is the @sentry/node docs' suggested upper bound for a
// pod's SIGTERM-to-exit window. Long enough to drain a small queue
// of pending events; short enough that K8s won't SIGKILL us first.
const FLUSH_TIMEOUT_MS = 2_000;

/**
 * Flush any in-flight Sentry events and disable the SDK. Call on
 * SIGTERM after other shutdown work so captured errors aren't lost.
 */
export async function flushSentry(): Promise<void> {
  await Sentry.close(FLUSH_TIMEOUT_MS);
}
