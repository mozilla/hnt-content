import * as Sentry from '@sentry/node';

export type InitOptions = {
  /** Static tag identifying the service, e.g. 'crawl-agent', 'crawl-worker'. */
  service: 'crawl-agent' | 'crawl-worker';
  /**
   * Static tag identifying the worker role within a service that runs
   * multiple roles from the same image. Required for crawl-worker
   * (article vs discovery); omit for crawl-agent.
   */
  workerRole?: 'article' | 'discovery';
};

/**
 * Initialize the Sentry SDK and attach static tags to the global scope.
 * DSN, environment, and release are read from env vars; an empty DSN
 * silently disables capture. Call once at process startup.
 */
export function initSentry({ service, workerRole }: InitOptions): void {
  const dsn = process.env.SENTRY_DSN;

  Sentry.init({
    dsn: dsn || undefined,
    environment: process.env.ENVIRONMENT,
    release: process.env.GIT_SHA,
    tracesSampleRate: 0,
    // OTel auto-instrumentation is unused (we capture errors manually)
    // and conflicts with mozcloud's OTEL Collector pipeline. Disabling
    // avoids loading the OpenTelemetry SDK at all.
    skipOpenTelemetrySetup: true,
  });

  const scope = Sentry.getGlobalScope();
  scope.setTag('service', service);
  if (workerRole) scope.setTag('worker_role', workerRole);

  if (!dsn) {
    console.log(`Sentry disabled: SENTRY_DSN not set (service=${service})`);
  }
}
