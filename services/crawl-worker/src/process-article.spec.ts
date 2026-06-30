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
    vi.mocked(releaseLock).mockResolvedValue();
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

  it('claims the fetch marker before the Zyte call and publish', async () => {
    await processArticle(BASE_MESSAGE);

    // The marker is a claim, so it must be written before the handler runs
    // and before publishing, not after them.
    const claimOrder = vi.mocked(setTimestamp).mock.invocationCallOrder[0]!;
    const extractOrder = vi.mocked(handleArticleExtraction).mock
      .invocationCallOrder[0]!;
    const publishOrder = vi.mocked(publishMessage).mock.invocationCallOrder[0]!;
    expect(claimOrder).toBeLessThan(extractOrder);
    expect(claimOrder).toBeLessThan(publishOrder);
  });

  it('skips a recently fetched article without extracting', async () => {
    vi.mocked(getTimestamp).mockResolvedValue(Date.now());

    expect(await processArticle(BASE_MESSAGE)).toEqual({
      outcome: 'skipped',
      reason: 'recent',
    });

    expect(acquireLock).not.toHaveBeenCalled();
    expect(handleArticleExtraction).not.toHaveBeenCalled();
    expect(publishMessage).not.toHaveBeenCalled();
  });

  it('dedups a live article within its refresh window', async () => {
    // Live articles no longer bypass the fetch check; they dedup on the
    // refresh interval carried on the message (default TTL when absent).
    vi.mocked(getTimestamp).mockResolvedValue(Date.now());

    expect(await processArticle(LIVE_MESSAGE)).toEqual({
      outcome: 'skipped',
      reason: 'recent',
    });
    expect(acquireLock).not.toHaveBeenCalled();
    expect(handleArticleExtraction).not.toHaveBeenCalled();
  });

  it('honors the per-message refresh interval when deduping', async () => {
    const tenMinutesAgo = Date.now() - 10 * 60_000;
    vi.mocked(getTimestamp).mockResolvedValue(tenMinutesAgo);

    // A 5-minute window: a 10-minute-old marker is stale, so it processes.
    expect(
      (await processArticle({ ...LIVE_MESSAGE, refresh_interval_minutes: 5 }))
        .outcome,
    ).toBe('processed');

    // A 60-minute window: the same marker is fresh, so it skips.
    expect(
      await processArticle({ ...LIVE_MESSAGE, refresh_interval_minutes: 60 }),
    ).toEqual({ outcome: 'skipped', reason: 'recent' });
  });

  it('re-checks article:fetch under the lock and skips a concurrent duplicate', async () => {
    // Pre-lock check sees no marker, but a concurrent job set article:fetch
    // after winning the lock first; the post-lock re-check must skip rather
    // than re-extract.
    vi.mocked(getTimestamp)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(Date.now());

    expect(await processArticle(BASE_MESSAGE)).toEqual({
      outcome: 'skipped',
      reason: 'recent',
    });

    expect(acquireLock).toHaveBeenCalled();
    expect(handleArticleExtraction).not.toHaveBeenCalled();
  });

  it('skips when another worker holds the lock', async () => {
    vi.mocked(acquireLock).mockResolvedValue(null);

    expect(await processArticle(BASE_MESSAGE)).toEqual({
      outcome: 'skipped',
      reason: 'lock_busy',
    });

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

  it('keeps the fetch claim when extraction throws, so a redelivery skips without re-fetching', async () => {
    vi.mocked(handleArticleExtraction).mockRejectedValueOnce(
      new Error('zyte failed'),
    );

    await expect(processArticle(BASE_MESSAGE)).rejects.toThrow('zyte failed');
    // The claim was written before the failing Zyte call.
    expect(setTimestamp).toHaveBeenCalledOnce();

    // Redelivery: the marker now exists, so the second delivery skips and
    // does not call Zyte again (the convergence property).
    vi.mocked(getTimestamp).mockResolvedValue(Date.now());
    expect(await processArticle(BASE_MESSAGE)).toEqual({
      outcome: 'skipped',
      reason: 'recent',
    });
    expect(handleArticleExtraction).toHaveBeenCalledTimes(1);
  });

  it('records the fetch claim before publishing, so a redelivery skips even when publishing throws', async () => {
    vi.mocked(publishMessage).mockRejectedValue(new Error('publish failed'));

    await expect(processArticle(BASE_MESSAGE)).rejects.toThrow(
      'publish failed',
    );
    // The claim is written before the publish, so it survives a publish
    // failure: the message nacks but the redelivery skips rather than
    // re-paying for Zyte (the accepted 99.9% under-emission tradeoff).
    expect(setTimestamp).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledWith(expect.any(String), 'lock-token');
  });

  it('still succeeds when releasing the lock fails (cleanup must not mask the outcome)', async () => {
    vi.mocked(releaseLock).mockRejectedValue(new Error('redis blip'));

    // A release failure in finally must not turn a successful publish
    // into a throw (which would nack and redeliver the message).
    expect(await processArticle(BASE_MESSAGE)).toEqual({
      outcome: 'processed',
    });
    expect(publishMessage).toHaveBeenCalledOnce();
    expect(setTimestamp).toHaveBeenCalledOnce();
  });

  it('returns processed on extraction and skipped when deduped', async () => {
    expect(await processArticle(BASE_MESSAGE)).toEqual({
      outcome: 'processed',
    });

    vi.mocked(getTimestamp).mockResolvedValue(Date.now());
    expect(await processArticle(BASE_MESSAGE)).toEqual({
      outcome: 'skipped',
      reason: 'recent',
    });
  });
});
