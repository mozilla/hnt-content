/**
 * Operational metrics client for the crawler. Holds a module-level
 * OpenTelemetry MeterProvider; nothing here needs the global registry,
 * which @sentry/node's own OTel setup shares.
 */
import {
  createNoopMeter,
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  type Attributes,
  type Meter,
} from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import config from './config.js';

/** Allowed values for the outcome tag. */
export const OUTCOME = { success: 'success', failure: 'failure' } as const;

export type Outcome = (typeof OUTCOME)[keyof typeof OUTCOME];

/**
 * Only low-cardinality tags (never url or crawl_id): each distinct value
 * becomes its own stored series. env and worker_role are attached at init.
 */
export type Tags = {
  outcome?: Outcome;
  /** What was enqueued or processed, e.g. 'page', 'live_article'. */
  kind?: string;
  /** Zyte extraction type, e.g. 'article', 'article_list'. */
  extraction?: string;
  /** Error class or status code, e.g. 'ZyteError', '429'. */
  error_type?: string;
  /** Upstream being called, e.g. 'zyte' or 'corpus_api'. */
  upstream?: string;
};

export interface MetricsInitOptions {
  /** Service name, e.g. 'crawl-agent'; becomes the Prometheus job label. */
  service: string;
  /** Which role a multi-role service runs as, e.g. 'article'. */
  workerRole?: string;
}

// Match the sentry package's flush timeout. Leaves most of the pod's 10s
// SIGTERM window for application shutdown and Pub/Sub drain.
const FLUSH_TIMEOUT_MS = 2_000;

let provider: MeterProvider | undefined;
// A noop until initMetrics succeeds, so emits are always safe to call.
let meter: Meter = createNoopMeter();
let baseTags: Attributes = {};

/**
 * Combine the base tags with per-call tags, dropping keys the caller left
 * undefined, which OTel would otherwise treat as a distinct label set.
 */
function mergeTags(tags?: Tags): Attributes {
  const merged: Attributes = { ...baseTags };
  if (!tags) return merged;
  for (const [key, value] of Object.entries(tags)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * Initialize the metrics provider and attach the static env and
 * worker_role tags. An empty OTLP endpoint disables emission. Call once
 * at process startup.
 */
export function initMetrics({ service, workerRole }: MetricsInitOptions): void {
  if (!config.endpoint) {
    console.log(`Metrics disabled: OTLP endpoint empty (service=${service})`);
    return;
  }

  // env and worker_role ride on every datapoint: only datapoint
  // attributes become queryable labels; resource attributes do not.
  baseTags = {};
  if (config.environment) baseTags.env = config.environment;
  if (workerRole) baseTags.worker_role = workerRole;

  // Export failures surface through the SDK's diag hook, which is silent
  // until a logger is set.
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

  try {
    provider = new MeterProvider({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: service }),
      readers: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: config.endpoint }),
        }),
      ],
    });
  } catch (err) {
    // The exporter rejects a malformed endpoint URL in its constructor;
    // run without metrics rather than crash the service.
    console.error('Metrics disabled: invalid OTLP endpoint', err);
    return;
  }
  meter = provider.getMeter(service);
}

/** Increment a counter. No-op when metrics are disabled. */
export function count(name: string, value = 1, tags?: Tags): void {
  // createCounter returns the existing instrument on repeat names.
  meter.createCounter(name).add(value, mergeTags(tags));
}

/** Record a timing in milliseconds. No-op when metrics are disabled. */
export function timing(name: string, ms: number, tags?: Tags): void {
  meter.createHistogram(name, { unit: 'ms' }).record(ms, mergeTags(tags));
}

/**
 * Run an async function and record its duration as a timing tagged by
 * outcome, whether it resolves or rejects, then re-throw on failure.
 * Splitting by outcome keeps fast failures, such as an upstream rejecting
 * every request, out of the success latency series. An `outcome` tag from
 * the caller is overwritten.
 */
export async function time<T>(
  name: string,
  fn: () => Promise<T>,
  tags?: Tags,
): Promise<T> {
  // Monotonic; wall time can step backwards.
  const start = performance.now();
  let outcome: Outcome = OUTCOME.failure;
  try {
    const result = await fn();
    outcome = OUTCOME.success;
    return result;
  } finally {
    timing(name, Math.round(performance.now() - start), { ...tags, outcome });
  }
}

/**
 * Flush pending datapoints and shut the provider down, if initialized.
 * Call on SIGTERM alongside shutdownSentry, after any Pub/Sub drain.
 */
export async function shutdownMetrics(): Promise<void> {
  if (!provider) return;
  const current = provider;
  provider = undefined;
  meter = createNoopMeter();
  try {
    await current.shutdown({ timeoutMillis: FLUSH_TIMEOUT_MS });
  } catch (err) {
    console.error('Metrics shutdown failed; datapoints may be lost', err);
  }
}
