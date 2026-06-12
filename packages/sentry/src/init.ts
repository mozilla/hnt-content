import * as Sentry from '@sentry/node';

export type SentryInitOptions = {
  /** Static tag identifying the service, e.g. 'crawl-agent', 'crawl-worker'. */
  service: string;
};

/**
 * Initialize the Sentry SDK and attach static tags to the global scope.
 * DSN, environment, and release are read from env vars; an empty DSN
 * silently disables capture. Call once at process startup.
 */
export function initSentry({ service }: SentryInitOptions): void {
  const dsn = process.env.SENTRY_DSN;

  // Keep tracing off by omitting tracesSampleRate (setting it to 0
  // would still register span machinery). Do NOT pass
  // skipOpenTelemetrySetup: true; that also skips installing
  // SentryContextManager, which withIsolationScope needs to fork
  // the scope rather than leak tags across handlers.
  //
  // tracePropagationTargets: [] disables sentry-trace/baggage
  // header injection on outbound HTTP/fetch. Without it, every
  // outgoing request (Zyte, Corpus API, gcloud auth) carries
  // headers we never read.
  //
  // Note: the default onUncaughtException integration calls
  // process.exit(1) on a truly uncaught exception, bypassing our
  // SIGTERM shutdown handler. Tolerable today; if shutdown
  // cleanliness on uncaught throws matters, pass `onFatalError`.
  Sentry.init({
    dsn: dsn || undefined,
    environment: process.env.ENVIRONMENT,
    release: process.env.GIT_SHA,
    tracePropagationTargets: [],
  });

  Sentry.getGlobalScope().setTag('service', service);

  if (!dsn) {
    console.log(`Sentry disabled: SENTRY_DSN not set (service=${service})`);
  }
}
