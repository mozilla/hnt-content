import { describe, expect, it } from 'vitest';
import {
  MessageValidationError,
  validateCrawlArticleMessage,
  validateCrawlArticleDiscoveryMessage,
} from './messages.js';

/** Return a shallow copy of obj without the given key. */
function omit<T extends object>(obj: T, key: keyof T): Partial<T> {
  const copy = { ...obj };
  delete copy[key];
  return copy;
}

const VALID_ARTICLE = {
  url: 'https://example.com/news/article-1',
  source_url: 'https://example.com/news',
  crawl_id: 'crawl-001',
  enqueued_at: '2025-06-01T12:00:00Z',
};

const VALID_CORPUS_ITEM = {
  external_id: 'ext-123',
  title: 'Original Headline',
  excerpt: 'Original excerpt text',
  authors: [{ name: 'Jane Doe' }],
  status: 'CORPUS',
  language: 'EN',
  publisher: 'Example News',
  image_url: 'https://s3.amazonaws.com/image.jpg',
  topic: 'TECHNOLOGY',
  is_time_sensitive: false,
};

const VALID_DISCOVERY = {
  url: 'https://example.com/news',
  interval_minutes: 20,
  contexts: [{ surface_id: 'NEW_TAB_EN_US', topic: 'technology' }],
};

describe('validateCrawlArticleMessage', () => {
  it('accepts a discovered-article message without corpus_item', () => {
    expect(validateCrawlArticleMessage(VALID_ARTICLE)).toEqual(VALID_ARTICLE);
  });

  it('accepts a live-article message with a full corpus_item', () => {
    const message = { ...VALID_ARTICLE, corpus_item: VALID_CORPUS_ITEM };
    expect(validateCrawlArticleMessage(message)).toEqual(message);
  });

  it('keeps a blank excerpt, which curators may leave empty', () => {
    const message = {
      ...VALID_ARTICLE,
      corpus_item: { ...VALID_CORPUS_ITEM, excerpt: '' },
    };
    expect(validateCrawlArticleMessage(message).corpus_item?.excerpt).toBe('');
  });

  it.each([null, undefined, 42, 'string', []])(
    'rejects a non-object payload (%s)',
    (raw) => {
      expect(() => validateCrawlArticleMessage(raw)).toThrow(
        MessageValidationError,
      );
    },
  );

  it.each(['url', 'source_url', 'crawl_id', 'enqueued_at'] as const)(
    'rejects a missing %s',
    (field) => {
      expect(() =>
        validateCrawlArticleMessage(omit(VALID_ARTICLE, field)),
      ).toThrow(new RegExp(field));
    },
  );

  it('rejects an empty url', () => {
    expect(() =>
      validateCrawlArticleMessage({ ...VALID_ARTICLE, url: '   ' }),
    ).toThrow(/url must be a non-empty string/);
  });

  it('rejects a non-string crawl_id', () => {
    expect(() =>
      validateCrawlArticleMessage({ ...VALID_ARTICLE, crawl_id: 7 }),
    ).toThrow(/crawl_id/);
  });

  it('rejects a corpus_item missing a required field', () => {
    const corpus = omit(VALID_CORPUS_ITEM, 'topic');
    expect(() =>
      validateCrawlArticleMessage({ ...VALID_ARTICLE, corpus_item: corpus }),
    ).toThrow(/corpus_item.topic/);
  });

  it('rejects a corpus_item with a non-boolean is_time_sensitive', () => {
    expect(() =>
      validateCrawlArticleMessage({
        ...VALID_ARTICLE,
        corpus_item: { ...VALID_CORPUS_ITEM, is_time_sensitive: 'no' },
      }),
    ).toThrow(/is_time_sensitive must be a boolean/);
  });

  it('rejects a corpus_item author without a name', () => {
    expect(() =>
      validateCrawlArticleMessage({
        ...VALID_ARTICLE,
        corpus_item: { ...VALID_CORPUS_ITEM, authors: [{}] },
      }),
    ).toThrow(/authors\[0\].name/);
  });
});

describe('validateCrawlArticleDiscoveryMessage', () => {
  it('accepts a well-formed discovery message', () => {
    expect(validateCrawlArticleDiscoveryMessage(VALID_DISCOVERY)).toEqual(
      VALID_DISCOVERY,
    );
  });

  it('rejects a missing interval_minutes', () => {
    expect(() =>
      validateCrawlArticleDiscoveryMessage(
        omit(VALID_DISCOVERY, 'interval_minutes'),
      ),
    ).toThrow(/interval_minutes must be a finite number/);
  });

  it('rejects a non-numeric interval_minutes', () => {
    expect(() =>
      validateCrawlArticleDiscoveryMessage({
        ...VALID_DISCOVERY,
        interval_minutes: '20',
      }),
    ).toThrow(/interval_minutes/);
  });

  it.each([0, -5])('rejects a non-positive interval_minutes (%s)', (value) => {
    expect(() =>
      validateCrawlArticleDiscoveryMessage({
        ...VALID_DISCOVERY,
        interval_minutes: value,
      }),
    ).toThrow(/interval_minutes must be a positive number/);
  });

  it('rejects an empty contexts array', () => {
    expect(() =>
      validateCrawlArticleDiscoveryMessage({
        ...VALID_DISCOVERY,
        contexts: [],
      }),
    ).toThrow(/contexts must not be empty/);
  });

  it('rejects a context missing surface_id', () => {
    expect(() =>
      validateCrawlArticleDiscoveryMessage({
        ...VALID_DISCOVERY,
        contexts: [{ topic: 'technology' }],
      }),
    ).toThrow(/contexts\[0\].surface_id/);
  });
});
