// Shared MozCloud OTEL gateway, which exports to Google Managed
// Prometheus, queried from Yardstick. Override the endpoint via
// OTEL_EXPORTER_OTLP_METRICS_ENDPOINT; set it empty to disable emission
// (e.g. local dev where no collector runs).
const GATEWAY_ENDPOINT =
  'http://mozcloud-opentelemetry-gateway-collector.mozcloud-opentelemetry.svc.cluster.local:4318/v1/metrics';

export default {
  endpoint: process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? GATEWAY_ENDPOINT,
  environment: process.env.ENVIRONMENT,
};
