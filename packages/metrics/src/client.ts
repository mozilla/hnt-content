/**
 * Operational metrics client for the crawler. Wraps `hot-shots` (StatsD UDP)
 * as a module-level singleton that emits to the MozCloud OTEL gateway.
 */
import { StatsD } from 'hot-shots';
import config from './config.js';

/**
 * Outcome tag values; the type below keeps counters and timings in step.
 * This is a plain object rather than a TypeScript `enum`. Node strips types
 * rather than compiling them, so an enum here would stop this file from being
 * imported by a one-off script that Node runs directly as TypeScript.
 */
export const OUTCOME = { success: 'success', failure: 'failure' } as const;

export type Outcome = (typeof OUTCOME)[keyof typeof OUTCOME];

/**
 * We only use low-cardinality tags (not url or crawl_id) because each
 * distinct value becomes its own stored metric, and TypeScript rejects any
 * other key passed directly. service, env and worker_role are set at init;
 * passing one here would overwrite it and mislabel the metric.
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
  /** Static tag identifying the service, e.g. 'crawl-agent', 'crawl-worker'. */
  service: string;
}

// Batch metrics rather than sending one packet per metric. The receiver
// aggregates over 30s, so this changes only datagram and syscall count,
// not the series recorded, and the shared gateway is alerted on CPU and
// memory. 1432 is the default 1460-byte GKE pod interface MTU less headers.
const MAX_BUFFER_BYTES = 1432;

// hot-shots calls errorHandler once per failed datagram, and its built-in
// fallback logs every one, so an unreachable gateway would fill the
// container log with identical lines; log the first, then summarize.
const ERROR_LOG_INTERVAL_MS = 60_000;

let client: StatsD | undefined;

/**
 * Build an error handler that logs at most one send failure per window
 * and counts the rest. State lives per client, so a re-init starts clean.
 */
function sendErrorLogger(): (err: Error) => void {
  let lastLoggedAt: number | undefined;
  let suppressed = 0;
  return (err) => {
    const now = Date.now();
    if (
      lastLoggedAt !== undefined &&
      now - lastLoggedAt < ERROR_LOG_INTERVAL_MS
    ) {
      suppressed += 1;
      return;
    }
    const summary = suppressed ? ` (${suppressed} similar suppressed)` : '';
    console.error(`Metrics send failed: ${err.message}${summary}`);
    lastLoggedAt = now;
    suppressed = 0;
  };
}

/**
 * Drop the keys a caller left undefined, which would otherwise reach the
 * wire as the string "undefined". Values are passed through: hot-shots
 * replaces the characters that break the line protocol, newlines and
 * carriage returns included, so it owns that guarantee.
 */
function cleanTags(tags?: Tags): Record<string, string> | undefined {
  if (!tags) return undefined;
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (value !== undefined) cleaned[key] = value;
  }
  return cleaned;
}

/**
 * Initialize the metrics client and attach the static service, env, and
 * worker_role tags. An empty STATSD_HOST disables emission, mirroring
 * Sentry's empty-DSN behavior. UDP is fire-and-forget, so socket and DNS
 * errors are logged rather than thrown. Call once at process startup; a
 * second call closes and replaces the previous client.
 */
export function initMetrics({ service }: MetricsInitOptions): void {
  // Close any existing socket first: a second init would otherwise leak
  // the descriptor, and the disabled path below would leave the earlier
  // client emitting while logging that metrics are off.
  client?.close();
  client = undefined;

  if (!config.host) {
    console.log(`Metrics disabled: STATSD_HOST empty (service=${service})`);
    return;
  }
  if (!config.environment) {
    // dev and stage share one gateway. The collector still separates them by
    // env_code, but our dashboards query this tag, so warn about its absence.
    console.warn('Metrics env tag unset: ENVIRONMENT empty');
  }

  const globalTags: Record<string, string> = { service };
  if (config.environment) globalTags.env = config.environment;
  if (config.workerRole) globalTags.worker_role = config.workerRole;

  client = new StatsD({
    host: config.host,
    port: config.port,
    globalTags,
    // Resolve the gateway's DNS name once per TTL. Without this every
    // send runs a getaddrinfo, fanned out by the pod's ndots search
    // list, on the same four libuv threads Zyte's fetch() competes for.
    cacheDns: true,
    maxBufferSize: MAX_BUFFER_BYTES,
    // Any of eleven DD_* env vars present in the pod would otherwise put
    // hot-shots into Datadog mode, which reads /proc/self/cgroup for
    // origin detection and adds `|c:` and telemetry to the wire.
    // DD_TAGS and DD_ENV would also land in globalTags and shadow ours.
    datadog: false,
    includeDataDogTags: false,
    errorHandler: sendErrorLogger(),
  });
}

/** Increment a counter. No-op when metrics are disabled. */
export function count(name: string, value = 1, tags?: Tags): void {
  client?.increment(name, value, cleanTags(tags));
}

/** Record a timing in milliseconds. No-op when metrics are disabled. */
export function timing(name: string, ms: number, tags?: Tags): void {
  client?.timing(name, ms, cleanTags(tags));
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
  // Monotonic: Date.now() can step backwards under an NTP correction or
  // a VM migration and emit a negative duration.
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
 * Flush and close the metrics client, if initialized. Call on SIGTERM
 * alongside shutdownSentry, after any Pub/Sub drain.
 */
export async function shutdownMetrics(): Promise<void> {
  if (!client) return;
  const current = client;
  client = undefined;
  await new Promise<void>((resolve) => current.close(() => resolve()));
}
