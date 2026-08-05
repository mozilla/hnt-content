// In-cluster StatsD endpoint of the shared MozCloud OTEL gateway, which
// exports to Google Managed Prometheus, queried from Yardstick. Override
// host/port via env; set STATSD_HOST empty to disable emission (e.g.
// local dev where the gateway DNS does not resolve).
const DEFAULT_HOST =
  'mozcloud-opentelemetry-gateway-statsd.mozcloud-opentelemetry.svc.cluster.local';

export default {
  host: process.env.STATSD_HOST ?? DEFAULT_HOST,
  port: Number(process.env.STATSD_PORT ?? '8125'),
  // Deploy environment tag, same ENVIRONMENT source as Sentry.
  environment: process.env.ENVIRONMENT,
  // Present only on the worker; tags metrics by article vs discovery.
  workerRole: process.env.WORKER_ROLE,
};
