import { setTimeout as delay } from 'node:timers/promises';
import { withSentryHandler } from 'sentry';

const MINUTE_MS = 60_000;

/**
 * Wait for the next epoch minute to begin and return it, or return null
 * if the signal aborts the wait. runEveryMinute waits on this between
 * ticks, so ticks start on minute boundaries and match the page offsets.
 */
export async function waitForNextMinute(
  signal: AbortSignal,
): Promise<number | null> {
  const nextMinute = Math.floor(Date.now() / MINUTE_MS) + 1;
  const msUntilNextMinute = nextMinute * MINUTE_MS - Date.now();
  try {
    await delay(msUntilNextMinute, undefined, { signal });
    return nextMinute;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return null;
    }
    throw err;
  }
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

  let epochMinute = await waitForNextMinute(signal);
  while (epochMinute !== null) {
    try {
      await tickWithSentry({
        epochMinute,
        startedAt: new Date().toISOString(),
      });
    } catch (err) {
      // Sentry already has the error, so log it and move on to the next tick.
      console.error('tick failed:', err);
    }
    epochMinute = await waitForNextMinute(signal);
  }
}
