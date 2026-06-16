import * as Sentry from '@sentry/node';
import config from './config.js';

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
  // Tracing stays off: we omit tracesSampleRate (setting it to 0 would
  // still register span machinery).
  //
  // The default onUncaughtException integration calls process.exit(1)
  // on a truly uncaught exception, bypassing our SIGTERM shutdown
  // handler. Tolerable today; if shutdown cleanliness on uncaught
  // throws matters, pass `onFatalError`.
  Sentry.init({
    dsn: config.dsn || undefined,
    environment: config.environment,
    release: config.release,
    // Keep Sentry's OpenTelemetry setup (the default): it installs the
    // context manager that withSentryHandler's isolation scope relies
    // on, so per-message tags don't leak across handlers.
    skipOpenTelemetrySetup: false,
    // Disable sentry-trace/baggage header injection on outbound
    // HTTP/fetch; without it every outgoing request (Zyte, Corpus
    // API, gcloud auth) carries headers we never read.
    tracePropagationTargets: [],
    // Raise from the 250-char default so longer errors aren't
    // truncated; adopted from the @pocket-tools/sentry library we used.
    maxValueLength: 2000,
  });

  Sentry.getGlobalScope().setTag('service', service);

  if (!config.dsn) {
    console.log(`Sentry disabled: SENTRY_DSN not set (service=${service})`);
  }
}
