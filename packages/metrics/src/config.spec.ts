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

  it('defaults to the cluster gateway when nothing is configured', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', undefined);
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', undefined);
    vi.stubEnv('HOST_IP', undefined);

    expect((await loadConfig()).endpoint).toBe(GATEWAY_ENDPOINT);
  });

  it('prefers the node-local collector when HOST_IP is set', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', undefined);
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', undefined);
    vi.stubEnv('HOST_IP', '10.1.2.3');

    expect((await loadConfig()).endpoint).toBe(
      'http://10.1.2.3:4318/v1/metrics',
    );
  });

  it('uses the metrics-specific endpoint verbatim', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', 'http://otel:4318/foo');
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://other:4318');

    expect((await loadConfig()).endpoint).toBe('http://otel:4318/foo');
  });

  it('appends the metrics path to the general endpoint', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', undefined);

    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://otel:4318');
    expect((await loadConfig()).endpoint).toBe('http://otel:4318/v1/metrics');

    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://otel:4318/');
    expect((await loadConfig()).endpoint).toBe('http://otel:4318/v1/metrics');
  });

  // An empty endpoint disables emission, so it must stay empty rather
  // than falling through to a default.
  it('keeps an empty endpoint empty rather than defaulting', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', '');
    expect((await loadConfig()).endpoint).toBe('');

    vi.stubEnv('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', undefined);
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '');
    expect((await loadConfig()).endpoint).toBe('');
  });

  it('reads the environment tag from ENVIRONMENT', async () => {
    vi.stubEnv('ENVIRONMENT', 'stage');

    expect((await loadConfig()).environment).toBe('stage');
  });
});
