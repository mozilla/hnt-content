import * as Sentry from '@sentry/node';
import type { SubscriberErrorContext } from './types.js';

/**
 * Build an `onError` callback for `startSubscriber` that reports
 * stream/close/parse errors to Sentry with the subscription name
 * and `kind` as tags, and logs them with a `pubsub:<kind>` prefix.
 * Pass to `startSubscriber({ onError: sentryPubSubErrorHandler('crawl-article') })`.
 */
export function sentryPubSubErrorHandler(
  subscriptionName: string,
): (err: Error, ctx: SubscriberErrorContext) => void {
  return (err, ctx) => {
    Sentry.captureException(err, {
      tags: { subscription: subscriptionName, kind: ctx.kind },
      contexts: ctx.messageId
        ? { handler: { messageId: ctx.messageId } }
        : undefined,
    });
    const id = ctx.messageId ? ` messageId=${ctx.messageId}` : '';
    console.error(
      `pubsub:${ctx.kind} subscription=${subscriptionName}${id}`,
      err,
    );
  };
}
