import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ delay: vi.fn() }));

// Real timers would make each test wait for a minute boundary.
vi.mock('node:timers/promises', () => ({ setTimeout: mocks.delay }));

import { runEveryMinute, waitForNextMinute } from './run-every-minute.js';

// A start partway through a minute shows the wait runs to the next one.
const START = new Date('2026-10-22T12:00:30Z');
const NEXT_MINUTE = new Date('2026-10-22T12:01:00Z');
const NEXT_EPOCH_MINUTE = NEXT_MINUTE.getTime() / 60_000;
let controller: AbortController;

beforeEach(() => {
  controller = new AbortController();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  // Behave like the real delay: fail once aborted, else let time pass.
  mocks.delay.mockImplementation(
    async (ms: number, _: unknown, { signal }: { signal: AbortSignal }) => {
      signal.throwIfAborted();
      vi.setSystemTime(Date.now() + ms);
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('waitForNextMinute', () => {
  it('waits until the next minute begins', async () => {
    await waitForNextMinute(controller.signal);

    expect(mocks.delay).toHaveBeenCalledWith(
      NEXT_MINUTE.getTime() - START.getTime(),
      undefined,
      { signal: controller.signal },
    );
  });

  it('returns the epoch minute it waited for', async () => {
    const epochMinute = await waitForNextMinute(controller.signal);

    expect(epochMinute).toBe(NEXT_EPOCH_MINUTE);
  });
});

describe('runEveryMinute', () => {
  it('calls the tick with each minute until the signal aborts', async () => {
    const tick = vi.fn(async () => {
      if (tick.mock.calls.length === 2) {
        controller.abort();
      }
    });

    await runEveryMinute(tick, controller.signal);

    expect(tick.mock.calls).toEqual([
      [NEXT_EPOCH_MINUTE],
      [NEXT_EPOCH_MINUTE + 1],
    ]);
  });

  it('keeps ticking after a tick fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const tick = vi.fn(async () => {
      if (tick.mock.calls.length === 1) {
        throw new Error('tick failed');
      }
      controller.abort();
    });

    await runEveryMinute(tick, controller.signal);

    expect(tick).toHaveBeenCalledTimes(2);
  });
});
