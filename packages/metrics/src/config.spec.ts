import { afterEach, describe, expect, it, vi } from 'vitest';

const GATEWAY_ENDPOINT =
  'http://mozcloud-opentelemetry-gateway-collector.mozcloud-opentelemetry.svc.cluster.local:4318/v1/metrics';

/** Re-import config so it re-reads process.env. */
async function loadConfig() {
  vi.resetModules();
  return (await import('./config.js')).default;
}

describe('metrics config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to the cluster gateway', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', undefined);

    expect((await loadConfig()).endpoint).toBe(GATEWAY_ENDPOINT);
  });

  it('uses OTEL_EXPORTER_OTLP_METRICS_ENDPOINT verbatim', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', 'http://otel:4318/foo');

    expect((await loadConfig()).endpoint).toBe('http://otel:4318/foo');
  });

  // An empty endpoint disables emission, so it must stay empty rather
  // than falling through to the default.
  it('keeps an empty endpoint empty rather than defaulting', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', '');

    expect((await loadConfig()).endpoint).toBe('');
  });
});
