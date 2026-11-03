import { describe, expect, it, vi } from 'vitest';

vi.mock('metrics', () => ({ duration: vi.fn() }));

import { duration } from 'metrics';
import { ZyteError } from 'zyte';
import { timeZyteCall } from './timed-call.js';

describe('timeZyteCall', () => {
  it.each([
    {
      name: 'success',
      call: async () => 'ok',
      tags: { item_type: 'article', outcome: 'success', error_type: undefined },
    },
    {
      name: 'Zyte error',
      call: async () => {
        throw new ZyteError(429, 'rate limited');
      },
      tags: { item_type: 'article', outcome: 'failure', error_type: '429' },
    },
    {
      name: 'other error',
      call: async () => {
        throw new TypeError('fetch failed');
      },
      tags: { item_type: 'article', outcome: 'failure', error_type: 'other' },
    },
  ])('records the call on $name', async ({ call, tags }) => {
    vi.mocked(duration).mockClear();
    await timeZyteCall('article', call).catch(() => {});

    const [[name, , , recorded]] = vi.mocked(duration).mock.calls;
    expect(name).toBe('crawl_zyte_request_duration');
    expect(recorded).toEqual(tags);
  });
});
