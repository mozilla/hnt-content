// Connection shared by every consumer of this package.
//
// TEMPORARY HNT-2086: the chart does not set REDIS_HOST because
// mozilla/webservices-infra#12479 is blocked from deployment.
// After #12479 is applied we can simply rely on REDIS_HOST.
const REDIS_HOST_BY_ENVIRONMENT: Record<string, string | undefined> = {
  dev: '172.16.37.52',
  stage: '172.16.37.60',
  prod: '172.16.18.188',
};

const environment = process.env.ENVIRONMENT ?? '';

export default {
  host: process.env.REDIS_HOST ?? REDIS_HOST_BY_ENVIRONMENT[environment],
};
