import { afterEach, describe, expect, it, vi } from 'vitest';

const GATEWAY_HOST =
  'mozcloud-opentelemetry-gateway-statsd.mozcloud-opentelemetry.svc.cluster.local';

/** Re-import config so it re-reads process.env. */
async function loadConfig() {
  vi.resetModules();
  return (await import('./config.js')).default;
}

describe('metrics config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to the in-cluster gateway on the StatsD port', async () => {
    vi.stubEnv('STATSD_HOST', undefined);
    vi.stubEnv('STATSD_PORT', undefined);

    const config = await loadConfig();

    expect(config.host).toBe(GATEWAY_HOST);
    expect(config.port).toBe(8125);
  });

  it('reads host, port, and env from the environment', async () => {
    vi.stubEnv('STATSD_HOST', 'localhost');
    vi.stubEnv('STATSD_PORT', '9125');
    vi.stubEnv('ENVIRONMENT', 'stage');

    expect(await loadConfig()).toMatchObject({
      host: 'localhost',
      port: 9125,
      environment: 'stage',
    });
  });

  // An empty host disables emission, so it must stay empty: `??` keeps it,
  // `||` would silently restore the gateway default.
  it('keeps an empty STATSD_HOST empty rather than defaulting', async () => {
    vi.stubEnv('STATSD_HOST', '');

    expect((await loadConfig()).host).toBe('');
  });
});
