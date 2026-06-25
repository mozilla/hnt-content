import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArticleEvent, CrawlArticleMessage } from 'crawl-common';

vi.mock('crawl-common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crawl-common')>();
  return {
    ...actual,
    acquireLock: vi.fn(),
    releaseLock: vi.fn(),
    getTimestamp: vi.fn(),
    setTimestamp: vi.fn(),
    getString: vi.fn(),
    setString: vi.fn(),
    publishMessage: vi.fn(),
  };
});

vi.mock('./handlers/extract-article.js', () => ({
  handleArticleExtraction: vi.fn(),
}));

import {
  acquireLock,
  getString,
  getTimestamp,
  publishMessage,
  releaseLock,
  setString,
  setTimestamp,
} from 'crawl-common';
import { handleArticleExtraction } from './handlers/extract-article.js';
import { processArticle } from './process-article.js';
import { BASE_MESSAGE, CORPUS_ITEM } from './handlers/test-helpers.js';

const EVENT: ArticleEvent = {
  url: BASE_MESSAGE.url,
  extracted_at: '2025-06-01T12:01:00Z',
  headline: 'Test Headline',
  description: 'Body text.',
};

const LIVE_MESSAGE: CrawlArticleMessage = {
  ...BASE_MESSAGE,
  corpus_item: CORPUS_ITEM,
};

describe('processArticle', () => {
  beforeEach(() => {
    // Happy path: not recently fetched, lock free, no prior content.
    vi.mocked(getTimestamp).mockResolvedValue(null);
    vi.mocked(acquireLock).mockResolvedValue('lock-token');
    vi.mocked(getString).mockResolvedValue(null);
    vi.mocked(handleArticleExtraction).mockResolvedValue(EVENT);
    vi.mocked(publishMessage).mockResolvedValue('message-id');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('extracts, publishes, and records fetch + content state for a new article', async () => {
    await processArticle(BASE_MESSAGE);

    expect(handleArticleExtraction).toHaveBeenCalledWith(BASE_MESSAGE);
    expect(publishMessage).toHaveBeenCalledWith('test-articles', EVENT);
    expect(setString).toHaveBeenCalledOnce();
    expect(setTimestamp).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledWith(expect.any(String), 'lock-token');
  });

  it('skips a recently fetched discovered article without extracting', async () => {
    vi.mocked(getTimestamp).mockResolvedValue(Date.now());

    await processArticle(BASE_MESSAGE);

    expect(acquireLock).not.toHaveBeenCalled();
    expect(handleArticleExtraction).not.toHaveBeenCalled();
    expect(publishMessage).not.toHaveBeenCalled();
  });

  it('fetches a live article even when recently fetched', async () => {
    vi.mocked(getTimestamp).mockResolvedValue(Date.now());

    await processArticle(LIVE_MESSAGE);

    expect(acquireLock).toHaveBeenCalledOnce();
    expect(handleArticleExtraction).toHaveBeenCalledWith(LIVE_MESSAGE);
  });

  it('skips when another worker holds the lock', async () => {
    vi.mocked(acquireLock).mockResolvedValue(null);

    await processArticle(BASE_MESSAGE);

    expect(handleArticleExtraction).not.toHaveBeenCalled();
    expect(publishMessage).not.toHaveBeenCalled();
    expect(releaseLock).not.toHaveBeenCalled();
  });

  it('skips publishing when content is unchanged but refreshes fetch and content state', async () => {
    // First fetch publishes and stores the content hash.
    await processArticle(BASE_MESSAGE);
    const storedHash = vi.mocked(setString).mock.calls[0]![1];
    vi.mocked(publishMessage).mockClear();
    vi.mocked(setString).mockClear();
    vi.mocked(setTimestamp).mockClear();

    // Second fetch: same content, so the stored hash matches.
    vi.mocked(getString).mockResolvedValue(storedHash);
    await processArticle(BASE_MESSAGE);

    expect(publishMessage).not.toHaveBeenCalled();
    // Both markers are refreshed so their TTLs stay in step and the
    // re-fetch window resets.
    expect(setString).toHaveBeenCalledOnce();
    expect(setTimestamp).toHaveBeenCalledOnce();
  });

  it('ignores extracted_at when detecting content changes', async () => {
    await processArticle(BASE_MESSAGE);
    const storedHash = vi.mocked(setString).mock.calls[0]![1];
    vi.mocked(publishMessage).mockClear();

    // Same content, only extracted_at differs: must not republish.
    vi.mocked(getString).mockResolvedValue(storedHash);
    vi.mocked(handleArticleExtraction).mockResolvedValue({
      ...EVENT,
      extracted_at: '2025-07-01T00:00:00Z',
    });
    await processArticle(BASE_MESSAGE);

    expect(publishMessage).not.toHaveBeenCalled();
  });

  it('releases the lock and propagates when extraction throws', async () => {
    const err = new Error('zyte failed');
    vi.mocked(handleArticleExtraction).mockRejectedValue(err);

    await expect(processArticle(BASE_MESSAGE)).rejects.toThrow(err);
    expect(releaseLock).toHaveBeenCalledWith(expect.any(String), 'lock-token');
    expect(publishMessage).not.toHaveBeenCalled();
  });

  it('does not record the fetch marker when publishing throws', async () => {
    vi.mocked(publishMessage).mockRejectedValue(new Error('publish failed'));

    await expect(processArticle(BASE_MESSAGE)).rejects.toThrow(
      'publish failed',
    );
    // Skipping setTimestamp lets the message redeliver and retry.
    expect(setTimestamp).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledWith(expect.any(String), 'lock-token');
  });

  it('returns processed on extraction and skipped when deduped', async () => {
    expect(await processArticle(BASE_MESSAGE)).toBe('processed');

    vi.mocked(getTimestamp).mockResolvedValue(Date.now());
    expect(await processArticle(BASE_MESSAGE)).toBe('skipped');
  });
});
