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
 * Wrap an async handler so its execution runs in a fresh Sentry
 * isolation scope. Tags and context from extractMetadata are
 * attached to anything captured during the call. Errors are
 * captured and rethrown so the caller's ack/nack semantics still
 * apply.
 */
export function withSentryHandler<T>(
  extractMetadata: (input: T) => HandlerMetadata,
  handler: (input: T) => Promise<void>,
): (input: T) => Promise<void> {
  return async (input) => {
    await Sentry.withIsolationScope(async () => {
      const { tags, context } = extractMetadata(input);
      if (tags) {
        for (const [k, v] of Object.entries(tags)) {
          if (v !== undefined) Sentry.setTag(k, v);
        }
      }
      if (context && Object.keys(context).length > 0) {
        Sentry.setContext('handler', context);
      }
      try {
        await handler(input);
      } catch (err) {
        Sentry.captureException(err);
        throw err;
      }
    });
  };
}
