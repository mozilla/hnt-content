/**
 * Operational metrics client for the crawler. Wraps `hot-shots`
 * (StatsD UDP) as a module-level singleton that emits to the MozCloud
 * OTEL gateway, mirroring the `sentry` package's shape. The emit API
 * is transport-agnostic, so an OTLP exporter could replace the StatsD
 * client without touching call sites.
 */
import { StatsD } from 'hot-shots';
import config from './config.js';

// One static tag set per call site; per-call tags merge over it.
export type Tags = Record<string, string>;

let client: StatsD | undefined;

export interface MetricsInitOptions {
  /** Static tag identifying the service, e.g. 'crawl-agent', 'crawl-worker'. */
  service: string;
}

/**
 * Initialize the metrics client and attach the static service, env,
 * and worker_role tags. An empty STATSD_HOST disables emission (the
 * emit functions become no-ops), mirroring Sentry's empty-DSN
 * behavior. UDP is fire-and-forget, so socket and DNS errors are
 * logged rather than thrown. Call once at process startup.
 */
export function initMetrics({ service }: MetricsInitOptions): void {
  if (!config.host) {
    console.log(`Metrics disabled: STATSD_HOST empty (service=${service})`);
    return;
  }
  const globalTags: Tags = { service };
  if (config.environment) globalTags.env = config.environment;
  if (config.workerRole) globalTags.worker_role = config.workerRole;
  client = new StatsD({
    host: config.host,
    port: config.port,
    globalTags,
    errorHandler: (err) => console.error('metrics:error', err.message),
  });
}

/** Increment a counter by one. No-op when metrics are disabled. */
export function incr(name: string, tags?: Tags): void {
  client?.increment(name, 1, tags);
}

/** Increment a counter by a given value. No-op when disabled. */
export function count(name: string, value: number, tags?: Tags): void {
  client?.increment(name, value, tags);
}

/** Record a timing in milliseconds. No-op when disabled. */
export function timing(name: string, ms: number, tags?: Tags): void {
  client?.timing(name, ms, tags);
}

/**
 * Run an async function and record its duration as a timing, whether
 * it resolves or rejects, then return or re-throw. No-op recording
 * when metrics are disabled.
 */
export async function time<T>(
  name: string,
  fn: () => Promise<T>,
  tags?: Tags,
): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    timing(name, Date.now() - start, tags);
  }
}

/**
 * Flush and close the metrics client. Idempotent; safe when
 * uninitialized. Call on SIGTERM after the Pub/Sub drain, alongside
 * shutdownSentry.
 */
export async function shutdownMetrics(): Promise<void> {
  if (!client) return;
  const current = client;
  client = undefined;
  await new Promise<void>((resolve) => current.close(() => resolve()));
}
