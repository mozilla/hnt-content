/**
 * Operational metrics client for the crawler. Wraps `hot-shots`
 * (StatsD UDP) as a module-level singleton that emits to the MozCloud
 * OTEL gateway, mirroring the `sentry` package's shape.
 */
import { StatsD } from 'hot-shots';
import config from './config.js';

/** Outcome tag values, shared so counters and timings agree. */
export const OUTCOME = { success: 'success', failure: 'failure' } as const;

export type Outcome = (typeof OUTCOME)[keyof typeof OUTCOME];

/**
 * Per-call tag vocabulary, closed on purpose. It keeps the label set
 * low-cardinality, since a url or crawl_id tag would create a series per
 * value, and it stops a per-call tag shadowing the identity tags set at
 * init, which hot-shots otherwise allows.
 */
export type Tags = {
  outcome?: Outcome;
  /** What was enqueued or processed, e.g. 'page', 'live_article'. */
  kind?: string;
  /** Zyte extraction type, e.g. 'article', 'article_list'. */
  extraction?: string;
  /** Error class or status code, e.g. 'ZyteError', '429'. */
  error_type?: string;
  /** Upstream being called, e.g. 'zyte', 'corpus_api', 'redis'. */
  upstream?: string;
};

export interface MetricsInitOptions {
  /** Static tag identifying the service, e.g. 'crawl-agent', 'crawl-worker'. */
  service: string;
}

// Batch metrics into one datagram rather than a packet per metric: at
// peak this sends roughly 4 datagrams/sec instead of 50, which matters at
// the shared gateway, where UDP receive-buffer overflow is the usual
// ingestion failure. 1432 bytes is the largest payload that avoids IP
// fragmentation on the 1460-byte MTU of a GKE VPC.
const MAX_BUFFER_BYTES = 1432;

// hot-shots calls errorHandler once per failed datagram, so an
// unreachable gateway logs about once a second. Container stderr is a
// synchronous pipe, so log the first failure and then summarize.
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
 * Collapse runs of characters outside the allowlist into one underscore.
 * hot-shots escapes `:|@,` but not newlines, and a newline in a tag value
 * ends the datagram and injects a second StatsD line.
 */
function sanitize(value: string): string {
  return value.replace(/[^\w./-]+/g, '_');
}

/** Sanitize tag values, dropping the keys a caller left undefined. */
function cleanTags(tags?: Tags): Record<string, string> | undefined {
  if (!tags) return undefined;
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (value !== undefined) cleaned[key] = sanitize(value);
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
    // dev and stage share one gateway, so an untagged series merges the
    // two environments instead of failing visibly.
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
    // list, on the libuv threadpool Zyte and Pub/Sub also use.
    cacheDns: true,
    maxBufferSize: MAX_BUFFER_BYTES,
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
 * after the Pub/Sub drain, alongside shutdownSentry.
 */
export async function shutdownMetrics(): Promise<void> {
  if (!client) return;
  const current = client;
  client = undefined;
  await new Promise<void>((resolve) => current.close(() => resolve()));
}
