import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('metrics', () => ({ incr: vi.fn(), timing: vi.fn() }));

import { incr, timing } from 'metrics';
import { withMessageMetrics, type HandlerResult } from './message-metrics.js';

describe('withMessageMetrics', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('records the processed outcome and the duration', async () => {
    const handler = vi.fn(
      async (): Promise<HandlerResult> => ({ outcome: 'processed' }),
    );

    await withMessageMetrics(handler)('msg');

    expect(handler).toHaveBeenCalledWith('msg');
    expect(incr).toHaveBeenCalledWith('crawl.message.processed', {
      outcome: 'processed',
    });
    expect(timing).toHaveBeenCalledWith(
      'crawl.message.duration_ms',
      expect.any(Number),
      { outcome: 'processed' },
    );
  });

  it.each(['recent', 'lock_busy'] as const)(
    'records the skipped outcome with the %s reason',
    async (reason) => {
      const handler = vi.fn(
        async (): Promise<HandlerResult> => ({ outcome: 'skipped', reason }),
      );

      await withMessageMetrics(handler)('msg');

      const tags = { outcome: 'skipped', reason };
      expect(incr).toHaveBeenCalledWith('crawl.message.processed', tags);
      expect(timing).toHaveBeenCalledWith(
        'crawl.message.duration_ms',
        expect.any(Number),
        tags,
      );
    },
  );

  it('records the error outcome and rethrows when the handler throws', async () => {
    const err = new Error('boom');
    const handler = vi.fn(async () => {
      throw err;
    });

    await expect(withMessageMetrics(handler)('msg')).rejects.toThrow(err);
    expect(incr).toHaveBeenCalledWith('crawl.message.processed', {
      outcome: 'error',
    });
    expect(timing).toHaveBeenCalledWith(
      'crawl.message.duration_ms',
      expect.any(Number),
      { outcome: 'error' },
    );
  });
});
