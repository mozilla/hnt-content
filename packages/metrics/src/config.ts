// OTLP metrics endpoint, e.g. the MozCloud collector on the pod's node
// (composed from the node IP in Helm). Unset disables emission, so
// local dev needs no configuration.
export default {
  endpoint: process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
  environment: process.env.ENVIRONMENT,
};
