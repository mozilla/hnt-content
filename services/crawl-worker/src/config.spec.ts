import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

/** Import a fresh config module with the given env overrides applied. */
async function loadConfig(
  overrides: Record<string, string | undefined>,
): Promise<(typeof import('./config.js'))['default']> {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV, ...overrides };
  return (await import('./config.js')).default;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('worker config lock TTL', () => {
  it('derives the lock TTL from the ack deadline, not the max extension', async () => {
    const config = await loadConfig({});

    expect(config.ackDeadlineSeconds).toBe(300);
    expect(config.lockTtlSeconds).toBe(270);
  });

  it('tracks ACK_DEADLINE_SECONDS and ignores MAX_EXTENSION_SECONDS', async () => {
    const config = await loadConfig({
      ACK_DEADLINE_SECONDS: '120',
      MAX_EXTENSION_SECONDS: '600',
    });

    expect(config.lockTtlSeconds).toBe(90);
    // The lock must clear before a crashed worker's message redelivers
    // around the ack deadline, so the retry re-fetches.
    expect(config.lockTtlSeconds).toBeLessThan(config.ackDeadlineSeconds);
  });

  it('throws when the ack deadline is too small for a positive lock TTL', async () => {
    await expect(loadConfig({ ACK_DEADLINE_SECONDS: '30' })).rejects.toThrow(
      'ACK_DEADLINE_SECONDS',
    );
  });
});
