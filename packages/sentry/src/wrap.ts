import * as Sentry from '@sentry/node';

export type HandlerMetadata = {
  /**
   * Low-cardinality key/value pairs set as Sentry tags (indexed,
   * searchable). Undefined values are skipped so callers can pass
   * optional fields without conditional branching. Example: topic,
   * surface_id, subscription.
   */
  tags?: Record<string, string | undefined>;
  /**
   * High-cardinality data set as the 'handler' Sentry context block
   * (visible on the issue but not indexed). Example: url, crawl_id.
   */
  context?: Record<string, unknown>;
};

/**
 * Wrap an async handler so events it reports to Sentry carry the tags
 * and context from extractMetadata, and any error it throws is
 * captured before being rethrown so the caller's ack/nack still apply.
 * Sentry groups a thrown error by stack trace and message, so messages
 * must not contain URLs, IDs or other per-event values; put those in
 * error fields or context instead.
 */
export function withSentryHandler<T>(
  extractMetadata: (input: T) => HandlerMetadata,
  handler: (input: T) => Promise<void>,
): (input: T) => Promise<void> {
  return async (input) => {
    // withIsolationScope forks a fresh isolation scope for this call,
    // isolating its events so tags/context here don't leak to others.
    await Sentry.withIsolationScope(async () => {
      const { tags, context } = extractMetadata(input);
      if (tags) {
        for (const [k, v] of Object.entries(tags)) {
          if (v !== undefined) {
            Sentry.setTag(k, v);
          }
        }
      }
      if (context && Object.keys(context).length > 0) {
        Sentry.setContext('handler', context);
      }
      try {
        await handler(input);
      } catch (err) {
        // The stack alone lumps different failures from one call site
        // together, e.g. a Zyte ban and a Zyte outage.
        Sentry.captureException(err, {
          fingerprint: [
            '{{ default }}',
            err instanceof Error ? err.message : String(err),
          ],
        });
        throw err;
      }
    });
  };
}
