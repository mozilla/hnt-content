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
 * needs a new tag. The MozCloud collector adds env_code and
 * component_code, so the environment and worker role need no tag.
 */
export type Tags = {
  outcome?: Outcome;
  // Type of item processed, e.g. 'article_list' or 'live_article'.
  item_type?: string;
  // Error class or status code, e.g. 'TimeoutError', '429'.
  error_type?: string;
};

export interface MetricsInitOptions {
  // Service name, e.g. 'crawl-worker'; becomes the Prometheus job label.
  service: string;
}

// Match the sentry package's flush timeout. Leaves most of the pod's 10s
// SIGTERM window for application shutdown and Pub/Sub drain.
const FLUSH_TIMEOUT_MS = 2_000;

let provider: MeterProvider | undefined;
// A noop until initMetrics succeeds, so emits are always safe to call.
let meter: Meter = createNoopMeter();

/**
 * Drop tags the caller left undefined, which OTel would otherwise treat
 * as a distinct label set.
 */
function definedTags(tags?: Tags): Attributes {
  const defined: Attributes = {};
  for (const [key, value] of Object.entries(tags ?? {})) {
    if (value !== undefined) {
      defined[key] = value;
    }
  }
  return defined;
}

/**
 * Initialize the metrics provider. An unset OTLP endpoint disables
 * emission. Call once at process startup.
 */
export function initMetrics({ service }: MetricsInitOptions): void {
  if (!config.endpoint) {
    console.log(
      `Metrics disabled: OTEL_EXPORTER_OTLP_METRICS_ENDPOINT not set ` +
        `(service=${service})`,
    );
    return;
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
  meter.createCounter(name).add(value, definedTags(tags));
}

/**
 * Record a duration in seconds. The SDK's default buckets stop at 10s,
 * so each caller passes boundaries that fit what it measures. No-op when
 * metrics are disabled.
 */
export function duration(
  name: string,
  seconds: number,
  buckets: number[],
  tags?: Tags,
): void {
  meter
    .createHistogram(name, {
      unit: 's',
      advice: { explicitBucketBoundaries: buckets },
    })
    .record(seconds, definedTags(tags));
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
