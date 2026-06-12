import * as Sentry from '@sentry/node';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sentryPubSubErrorHandler } from './sentry-error-handler.js';

vi.mock('@sentry/node', () => ({
  captureException: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(Sentry.captureException).mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('sentryPubSubErrorHandler', () => {
  it('captures stream-error with the subscription tag', () => {
    const handler = sentryPubSubErrorHandler('crawl-article');
    const err = new Error('stream broke');

    handler(err, { kind: 'stream-error' });

    expect(Sentry.captureException).toHaveBeenCalledWith(err, {
      tags: { subscription: 'crawl-article', kind: 'stream-error' },
      contexts: undefined,
    });
  });

  it('captures parse-error with messageId in context', () => {
    const handler = sentryPubSubErrorHandler('crawl-article');
    const err = new SyntaxError('bad json');

    handler(err, { kind: 'parse-error', messageId: 'abc-1' });

    expect(Sentry.captureException).toHaveBeenCalledWith(err, {
      tags: { subscription: 'crawl-article', kind: 'parse-error' },
      contexts: { handler: { messageId: 'abc-1' } },
    });
  });

  it('captures close-error without messageId', () => {
    const handler = sentryPubSubErrorHandler('crawl-article');
    const err = new Error('gRPC close failed');

    handler(err, { kind: 'close-error' });

    expect(Sentry.captureException).toHaveBeenCalledWith(err, {
      tags: { subscription: 'crawl-article', kind: 'close-error' },
      contexts: undefined,
    });
  });
});
