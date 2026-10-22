import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ delay: vi.fn() }));

// Real timers would make each test wait for a minute boundary.
vi.mock('node:timers/promises', () => ({ setTimeout: mocks.delay }));

import { runEveryMinute, waitForNextMinute } from './run-every-minute.js';

const START = new Date('2026-10-22T12:00:30Z');
const START_MINUTE = Math.floor(START.getTime() / 60_000);
const signal = new AbortController().signal;
const abortError = Object.assign(new Error('aborted'), {
  name: 'AbortError',
});

/**
 * Let the first `waits` sleeps finish by moving the clock forward, then
 * abort the next one, as shutdown would.
 */
function abortAfterWaits(waits: number) {
  let calls = 0;
  mocks.delay.mockImplementation(async (ms: number) => {
    if (calls++ === waits) {
      throw abortError;
    }
    vi.setSystemTime(Date.now() + ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  abortAfterWaits(Infinity);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('waitForNextMinute', () => {
  it('waits until the next minute begins', async () => {
    await waitForNextMinute(signal);

    expect(mocks.delay).toHaveBeenCalledWith(30_000, undefined, { signal });
  });

  it('returns the epoch minute it waited for', async () => {
    const epochMinute = await waitForNextMinute(signal);

    expect(epochMinute).toBe(START_MINUTE + 1);
  });

  it('returns null when the signal aborts the wait', async () => {
    abortAfterWaits(0);

    const epochMinute = await waitForNextMinute(signal);

    expect(epochMinute).toBeNull();
  });
});

describe('runEveryMinute', () => {
  it('calls the tick with each minute until the signal aborts', async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    abortAfterWaits(2);

    await runEveryMinute(tick, signal);

    expect(tick.mock.calls).toEqual([[START_MINUTE + 1], [START_MINUTE + 2]]);
  });

  it('keeps ticking after a tick fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const tick = vi
      .fn()
      .mockRejectedValueOnce(new Error('tick failed'))
      .mockResolvedValue(undefined);
    abortAfterWaits(2);

    await runEveryMinute(tick, signal);

    expect(tick).toHaveBeenCalledTimes(2);
  });
});
