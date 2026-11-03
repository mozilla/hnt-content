import { describe, expect, it, vi } from 'vitest';

vi.mock('metrics', () => ({ duration: vi.fn() }));

import { duration } from 'metrics';
import { ZyteError } from 'zyte';
import { timeZyteCall } from './timed-call.js';

describe('timeZyteCall', () => {
  it('returns the result and records a success', async () => {
    vi.mocked(duration).mockClear();
    // The call appears to take 2.5s.
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(3_500);
    await expect(timeZyteCall('article', async () => 'ok')).resolves.toBe('ok');

    const [[name, seconds, tags]] = vi.mocked(duration).mock.calls;
    expect(name).toBe('crawl_zyte_request_duration');
    expect(seconds).toBe(2.5);
    expect(tags).toEqual({ item_type: 'article', outcome: 'success' });
  });

  it.each([
    { error: new ZyteError(429, 'rate limited'), errorType: '429' },
    {
      error: new DOMException('timed out', 'TimeoutError'),
      errorType: 'TimeoutError',
    },
  ])(
    'rethrows and records a $errorType failure',
    async ({ error, errorType }) => {
      vi.mocked(duration).mockClear();
      await expect(
        timeZyteCall('article', async () => {
          throw error;
        }),
      ).rejects.toBe(error);

      const [[, , tags]] = vi.mocked(duration).mock.calls;
      expect(tags).toEqual({
        item_type: 'article',
        outcome: 'failure',
        error_type: errorType,
      });
    },
  );
});
