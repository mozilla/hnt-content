import { incr, timing } from 'metrics';

/** Why a handler skipped a message: too recently fetched, or lock held. */
export type SkipReason = 'recent' | 'lock_busy';

/**
 * Result of a message handler: real work, or a skip with its reason.
 * The reason is surfaced as a metric tag so skips can be split between
 * dedup (recent) and lock contention (lock_busy).
 */
export type HandlerResult =
  | { outcome: 'processed' }
  | { outcome: 'skipped'; reason: SkipReason };

/**
 * Wrap a message handler to record processing latency and a per-outcome
 * counter. A thrown error is tagged `error` and rethrown so the
 * subscriber still nacks; a normal return is tagged with the handler's
 * own processed/skipped outcome (a skip acks but is not real work) and,
 * for a skip, the reason.
 */
export function withMessageMetrics<T>(
  handler: (message: T) => Promise<HandlerResult>,
): (message: T) => Promise<void> {
  return async (message) => {
    const start = Date.now();
    try {
      const result = await handler(message);
      record(
        start,
        result.outcome === 'skipped'
          ? { outcome: 'skipped', reason: result.reason }
          : { outcome: 'processed' },
      );
    } catch (err) {
      record(start, { outcome: 'error' });
      throw err;
    }
  };
}

/** Emit the duration timer and processed counter with the given tags. */
function record(start: number, tags: Record<string, string>): void {
  timing('crawl.message.duration_ms', Date.now() - start, tags);
  incr('crawl.message.processed', tags);
}
