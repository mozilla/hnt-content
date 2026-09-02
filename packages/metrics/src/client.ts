/**
 * Operational metrics client based on OpenTelemetry (OTel). The provider
 * is not registered on OTel's global API, so `metrics.getMeter()` returns
 * a noop meter; record through this module's functions instead.
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
export type Outcome = 'success' | 'failure';

/**
 * Only low-cardinality tags (never a URL or an ID): each distinct value
 * becomes its own stored series. Extend this closed set when a metric
 * needs a new tag. env and worker_role are attached at init.
 */
export type Tags = {
  outcome?: Outcome;
  // Type of item processed, e.g. 'page' or 'live_article'.
  item_type?: string;
  // Error class or status code, e.g. 'TimeoutError', '429'.
  error_type?: string;
  // External service being called.
  upstream?: string;
};

export interface MetricsInitOptions {
  // Service name, e.g. 'crawl-agent'; becomes the Prometheus job label.
  service: string;
  // Which role a multi-role service runs as, e.g. 'article'.
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
function mergeTagsWithBase(tags?: Tags): Attributes {
  const merged: Attributes = { ...baseTags };
  if (!tags) {
    return merged;
  }
  for (const [key, value] of Object.entries(tags)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Initialize the metrics provider and attach the static env and
 * worker_role tags. An unset OTLP endpoint disables emission. Call once
 * at process startup.
 */
export function initMetrics({ service, workerRole }: MetricsInitOptions): void {
  if (!config.endpoint) {
    console.log(
      `Metrics disabled: OTEL_EXPORTER_OTLP_METRICS_ENDPOINT not set ` +
        `(service=${service})`,
    );
    return;
  }

  // env and worker_role ride on every datapoint: only datapoint
  // attributes become queryable labels; resource attributes do not.
  baseTags = {};
  if (config.environment) {
    baseTags.env = config.environment;
  }
  if (workerRole) {
    baseTags.worker_role = workerRole;
  }

  // Log export failures to console.error; the SDK is silent by default.
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

  try {
    // The MeterProvider is the SDK entry point that owns the export pipeline.
    // https://opentelemetry.io/docs/specs/otel/metrics/api/#meterprovider
    provider = new MeterProvider({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: service }),
      readers: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: config.endpoint }),
        }),
      ],
    });
  } catch (err) {
    // Invalid configuration, such as a malformed endpoint URL, throws in
    // the constructors; run without metrics rather than crash the service.
    console.error('Metrics disabled: invalid configuration', err);
    return;
  }
  meter = provider.getMeter(service);
}

/** Increment a counter. No-op when metrics are disabled. */
export function count(name: string, value = 1, tags?: Tags): void {
  // createCounter returns the existing instrument on repeat names.
  meter.createCounter(name).add(value, mergeTagsWithBase(tags));
}

/** Record a timing in milliseconds. No-op when metrics are disabled. */
export function timing(name: string, ms: number, tags?: Tags): void {
  meter
    .createHistogram(name, { unit: 'ms' })
    .record(ms, mergeTagsWithBase(tags));
}

/**
 * Flush pending datapoints and shut the provider down, if initialized.
 * Call on SIGTERM alongside shutdownSentry, after any Pub/Sub drain.
 */
export async function shutdownMetrics(): Promise<void> {
  if (!provider) {
    return;
  }
  const current = provider;
  provider = undefined;
  meter = createNoopMeter();
  try {
    await current.shutdown({ timeoutMillis: FLUSH_TIMEOUT_MS });
  } catch (err) {
    console.error('Metrics shutdown failed; datapoints may be lost', err);
  }
}
