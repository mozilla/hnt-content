import type {
  InMemoryMetricExporter,
  MetricData,
} from '@opentelemetry/sdk-metrics';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted so the vi.mock factory and the tests share these bindings;
// see the pattern notes in packages/crawl-common/src/pubsub/client.spec.ts.

// On each `new OTLPMetricExporter(...)`, the mocked constructor creates an
// in-memory exporter and assigns it here; tests read its recorded
// datapoints. Stays undefined while metrics are disabled.
let mockExporter = vi.hoisted(
  () => undefined as InMemoryMetricExporter | undefined,
);

// On every `new OTLPMetricExporter(...)` call, the mocked constructor
// writes its options argument here. Tests read it to assert how
// initMetrics initialized the exporter.
let mockExporterConstructorArgs = vi.hoisted(() => undefined as unknown);

// Swap the OTLP exporter for the SDK's in-memory one so tests assert on
// real recorded datapoints rather than mocks of the metrics pipeline.
vi.mock('@opentelemetry/exporter-metrics-otlp-proto', async () => {
  const { AggregationTemporality, InMemoryMetricExporter } =
    await import('@opentelemetry/sdk-metrics');
  return {
    OTLPMetricExporter: vi.fn(function OTLPMetricExporter(options: {
      url: string;
    }) {
      // The real exporter rejects malformed URLs in its constructor.
      new URL(options.url);
      mockExporterConstructorArgs = options;
      mockExporter = new InMemoryMetricExporter(
        AggregationTemporality.CUMULATIVE,
      );
      return mockExporter;
    }),
  };
});

// Replace the real config with a test-owned object so setting endpoint
// and environment below does not mutate the real module.
vi.mock('./config.js', () => ({ default: {} }));

import config from './config.js';
import {
  OUTCOME,
  count,
  initMetrics,
  shutdownMetrics,
  time,
  timing,
} from './client.js';

/** Flush via shutdown and return the exported metrics keyed by name. */
async function flush(): Promise<Map<string, MetricData>> {
  await shutdownMetrics();
  const metrics = mockExporter!
    .getMetrics()
    .flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics));
  return new Map(metrics.map((m) => [m.descriptor.name, m]));
}

describe('metrics client', () => {
  beforeEach(() => {
    config.endpoint = 'http://collector:4318/v1/metrics';
    config.environment = 'test';
    mockExporter = undefined;
    mockExporterConstructorArgs = undefined;
  });

  afterEach(async () => {
    await shutdownMetrics();
    vi.restoreAllMocks();
  });

  it('exports counters with base and per-call tags', async () => {
    initMetrics({ service: 'crawl-worker', workerRole: 'article' });

    count('crawl.tick.enqueued', 3, { kind: 'page' });
    count('crawl.tick.enqueued', 2, { kind: 'page' });
    count('crawl.tick.ran');

    const metrics = await flush();
    const enqueued = metrics.get('crawl.tick.enqueued')!.dataPoints;
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].value).toBe(5);
    expect(enqueued[0].attributes).toEqual({
      env: 'test',
      worker_role: 'article',
      kind: 'page',
    });
    expect(metrics.get('crawl.tick.ran')!.dataPoints[0].value).toBe(1);
  });

  it('exports timings as millisecond histograms', async () => {
    initMetrics({ service: 'crawl-worker' });

    timing('crawl.message.duration_ms', 42, { outcome: OUTCOME.success });

    const metric = (await flush()).get('crawl.message.duration_ms')!;
    expect(metric.descriptor.unit).toBe('ms');
    expect(metric.dataPoints[0].attributes).toEqual({
      env: 'test',
      outcome: 'success',
    });
    expect(metric.dataPoints[0].value).toMatchObject({ count: 1, sum: 42 });
  });

  it('omits env and worker_role when neither is supplied', async () => {
    config.environment = undefined;
    initMetrics({ service: 'crawl-agent' });

    count('crawl.tick.ran');

    const metrics = await flush();
    expect(metrics.get('crawl.tick.ran')!.dataPoints[0].attributes).toEqual({});
  });

  it('drops tags left undefined so callers need no branching', async () => {
    initMetrics({ service: 'crawl-worker' });

    count('crawl.message.processed', 1, {
      outcome: OUTCOME.success,
      kind: undefined,
    });

    const metrics = await flush();
    expect(
      metrics.get('crawl.message.processed')!.dataPoints[0].attributes,
    ).toEqual({ env: 'test', outcome: 'success' });
  });

  it('records a timing tagged by outcome on both success and failure', async () => {
    initMetrics({ service: 'crawl-worker' });

    const value = await time(
      'crawl.zyte.duration_ms',
      () => Promise.resolve(7),
      { extraction: 'article' },
    );
    expect(value).toBe(7);

    await expect(
      time('crawl.zyte.duration_ms', () => Promise.reject(new Error('boom')), {
        extraction: 'article',
      }),
    ).rejects.toThrow('boom');

    // A shared outcome tag would hide fast failures in the success p95.
    const points = (await flush()).get('crawl.zyte.duration_ms')!.dataPoints;
    expect(points).toHaveLength(2);
    for (const point of points) {
      expect(point.attributes.extraction).toBe('article');
      expect(point.value).toMatchObject({ count: 1 });
    }
    expect(points.map((p) => p.attributes.outcome).sort()).toEqual([
      'failure',
      'success',
    ]);
  });

  it('overwrites an outcome tag supplied by the caller', async () => {
    initMetrics({ service: 'crawl-worker' });

    await time('crawl.zyte.duration_ms', () => Promise.resolve(1), {
      outcome: OUTCOME.failure,
    });

    const points = (await flush()).get('crawl.zyte.duration_ms')!.dataPoints;
    expect(points).toHaveLength(1);
    expect(points[0].attributes.outcome).toBe('success');
  });

  it('is a no-op when the endpoint is empty', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    config.endpoint = '';
    initMetrics({ service: 'crawl-worker' });

    count('crawl.message.processed');
    timing('crawl.message.duration_ms', 5);
    await expect(
      time('crawl.zyte.duration_ms', () => Promise.resolve(7)),
    ).resolves.toBe(7);

    expect(mockExporter).toBeUndefined();
  });

  it('disables metrics when the endpoint is malformed', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    config.endpoint = 'not a url';

    initMetrics({ service: 'crawl-worker' });
    count('crawl.tick.ran');

    expect(mockExporter).toBeUndefined();
  });

  it('flushes pending datapoints on shutdown', async () => {
    initMetrics({ service: 'crawl-worker' });
    count('crawl.tick.ran');

    await shutdownMetrics();

    expect(mockExporterConstructorArgs).toEqual({
      url: 'http://collector:4318/v1/metrics',
    });
    const [resourceMetrics] = mockExporter!.getMetrics();
    expect(resourceMetrics.resource.attributes['service.name']).toBe(
      'crawl-worker',
    );
    expect(resourceMetrics.scopeMetrics[0].metrics[0].dataPoints[0].value).toBe(
      1,
    );

    // Emitting after shutdown is a silent no-op.
    count('crawl.tick.ran');
    expect(mockExporter!.getMetrics()).toHaveLength(1);
  });
});
