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
      record(start, await handler(message));
    } catch (err) {
      record(start, 'error');
      throw err;
    }
  };
}

/** Emit the duration timer and processed counter tagged by outcome. */
function record(start: number, result: HandlerResult | 'error'): void {
  const tags: Record<string, string> =
    result === 'error'
      ? { outcome: 'error' }
      : result.outcome === 'skipped'
        ? { outcome: 'skipped', reason: result.reason }
        : { outcome: 'processed' };
  timing('crawl.message.duration_ms', Date.now() - start, tags);
  incr('crawl.message.processed', tags);
}
