// Shared MozCloud OTEL gateway, which exports to Google Managed
// Prometheus, queried from Yardstick.
const GATEWAY_ENDPOINT =
  'http://mozcloud-opentelemetry-gateway-collector.mozcloud-opentelemetry.svc.cluster.local:4318/v1/metrics';

/**
 * Resolve the OTLP metrics endpoint with the standard env var precedence:
 * the metrics-specific endpoint is used verbatim, the general endpoint
 * gets the metrics path appended. Setting either to the empty string
 * disables emission (e.g. local dev where no collector runs). By default,
 * prefer the node-local collector when Helm injects HOST_IP; otherwise
 * fall back to the cluster gateway.
 */
function resolveEndpoint(): string {
  const metricsEndpoint = process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
  if (metricsEndpoint !== undefined) return metricsEndpoint;

  const baseEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (baseEndpoint === '') return '';
  if (baseEndpoint !== undefined) {
    return `${baseEndpoint.replace(/\/$/, '')}/v1/metrics`;
  }

  const hostIp = process.env.HOST_IP;
  return hostIp ? `http://${hostIp}:4318/v1/metrics` : GATEWAY_ENDPOINT;
}

export default {
  endpoint: resolveEndpoint(),
  environment: process.env.ENVIRONMENT,
};
