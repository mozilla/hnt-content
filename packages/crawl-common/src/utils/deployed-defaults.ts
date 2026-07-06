// TEMPORARY WORKAROUND (HNT-2086): this whole module is throwaway.
// Per-environment fallbacks for non-secret runtime config the mozcloud
// chart does not yet inject. PROJECT_ID and REDIS_HOST move to the
// hnt-config configMap once the matching webservices-infra change lands;
// until then a deploy reads these so the agent and workers can reach
// Pub/Sub and Redis. Config wires them as the fallback only when the env
// var is unset, so a deploy that does set them (and local dev, which
// sets the real values via .env) never hits these. Delete this module,
// its spec, and the two config call sites once the chart sets both.

type DeployEnvironment = 'dev' | 'stage' | 'prod';

// Memorystore primary IPs per environment. The proper config points
// REDIS_HOST at a DNS name; these IPs are the stopgap until that lands.
const REDIS_HOST_BY_ENV: Record<DeployEnvironment, string> = {
  dev: '172.16.37.52',
  stage: '172.16.37.60',
  prod: '172.16.18.188',
};

const PROJECT_ID_BY_ENV: Record<DeployEnvironment, string> = {
  dev: 'moz-fx-hnt-nonprod',
  stage: 'moz-fx-hnt-nonprod',
  prod: 'moz-fx-hnt-prod',
};

/** Return whether a value names a known deploy environment. */
function isDeployEnvironment(
  value: string | undefined,
): value is DeployEnvironment {
  return value === 'dev' || value === 'stage' || value === 'prod';
}

/**
 * Return the stopgap Redis host for a deploy environment, or '' for an
 * unknown one (e.g. local dev), so callers keep the prior empty default.
 */
export function deployedRedisHost(environment: string | undefined): string {
  return isDeployEnvironment(environment) ? REDIS_HOST_BY_ENV[environment] : '';
}

/** Return the stopgap GCP project id for a deploy environment, or ''. */
export function deployedProjectId(environment: string | undefined): string {
  return isDeployEnvironment(environment) ? PROJECT_ID_BY_ENV[environment] : '';
}
