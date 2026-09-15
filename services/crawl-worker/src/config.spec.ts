import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

/** Import a fresh config module with the given environment applied. */
async function loadConfig(overrides: Record<string, string | undefined>) {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV, ...overrides };
  return (await import('./config.js')).default;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('crawl-worker config', () => {
  it('derives the lock TTL from the ack deadline', async () => {
    const config = await loadConfig({});
    expect(config.lockTtlSeconds).toBe(config.ackDeadlineSeconds - 30);
    expect(config.maxExtensionSeconds).toBeLessThanOrEqual(
      config.ackDeadlineSeconds,
    );
  });

  it.each([undefined, '', 'bogus'])(
    'rejects WORKER_ROLE %s',
    async (workerRole) => {
      await expect(loadConfig({ WORKER_ROLE: workerRole })).rejects.toThrow(
        /WORKER_ROLE/,
      );
    },
  );

  it.each([undefined, ''])('rejects ENVIRONMENT %s', async (environment) => {
    await expect(loadConfig({ ENVIRONMENT: environment })).rejects.toThrow(
      /ENVIRONMENT/,
    );
  });
});
