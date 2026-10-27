import { setTimeout as delay } from 'node:timers/promises';
import { withSentryHandler } from 'sentry';

const MINUTE_MS = 60_000;

/**
 * Wait for the next epoch minute to begin and return it. runEveryMinute
 * waits on this between ticks, so ticks start on minute boundaries and
 * match the page offsets.
 */
export async function waitForNextMinute(signal: AbortSignal): Promise<number> {
  const nextMinute = Math.floor(Date.now() / MINUTE_MS) + 1;
  const msUntilNextMinute = nextMinute * MINUTE_MS - Date.now();
  await delay(msUntilNextMinute, undefined, { signal });
  return nextMinute;
}

/**
 * Call tick at the start of every minute until the signal aborts. Ticks
 * never overlap, so minutes a slow tick overruns are skipped.
 */
export async function runEveryMinute(
  tick: (epochMinute: number) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const tickWithSentry = withSentryHandler<{
    epochMinute: number;
    startedAt: string;
  }>(
    (context) => ({ context }),
    ({ epochMinute }) => tick(epochMinute),
  );

  // Loops until signal.aborted, which the scheduler sets on SIGTERM or
  // SIGINT to shut down.
  for (;;) {
    try {
      const epochMinute = await waitForNextMinute(signal);
      await tickWithSentry({
        epochMinute,
        startedAt: new Date().toISOString(),
      });
    } catch (err) {
      // Shutdown aborts the wait; any other error is a failed tick.
      if (signal.aborted) {
        return;
      }
      // Sentry already has the error, so log it and move on to the next tick.
      console.error('tick failed:', err);
    }
  }
}
