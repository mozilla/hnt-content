import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('metrics', () => ({ incr: vi.fn(), timing: vi.fn() }));

import { incr, timing } from 'metrics';
import { withMessageMetrics } from './message-metrics.js';

describe('withMessageMetrics', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each(['processed', 'skipped'] as const)(
    'records the %s outcome and the duration',
    async (outcome) => {
      const handler = vi.fn(async () => outcome);

      await withMessageMetrics(handler)('msg');

      expect(handler).toHaveBeenCalledWith('msg');
      expect(incr).toHaveBeenCalledWith('crawl.message.processed', { outcome });
      expect(timing).toHaveBeenCalledWith(
        'crawl.message.duration_ms',
        expect.any(Number),
        { outcome },
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
