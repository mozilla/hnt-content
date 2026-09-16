/** Why a step skipped a message: fetched too recently, or lock held. */
export type SkipReason = 'recent' | 'lock_busy';

/**
 * Outcome of a process step. A skip is a normal return rather than a
 * thrown error, so the subscriber acks the message instead of nacking
 * work that another worker already owns or already did. The reason
 * separates deduplication from lock contention when a skip is logged.
 */
export type HandlerResult =
  | { outcome: 'processed' }
  | { outcome: 'skipped'; reason: SkipReason };
