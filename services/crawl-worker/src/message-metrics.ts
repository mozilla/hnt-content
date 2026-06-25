import { incr, timing } from 'metrics';

/** Whether a message did real work or was skipped by dedup/lock. */
export type MessageOutcome = 'processed' | 'skipped';

/**
 * Wrap a message handler to record processing latency and a per-outcome
 * counter. A thrown error is tagged `error` and rethrown so the
 * subscriber still nacks; a normal return is tagged with the handler's
 * own processed/skipped outcome (a skip acks but is not real work).
 */
export function withMessageMetrics<T>(
  handler: (message: T) => Promise<MessageOutcome>,
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
function record(start: number, outcome: MessageOutcome | 'error'): void {
  const tags = { outcome };
  timing('crawl.message.duration_ms', Date.now() - start, tags);
  incr('crawl.message.processed', tags);
}
