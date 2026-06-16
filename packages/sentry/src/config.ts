export default {
  dsn: process.env.SENTRY_DSN,
  environment: process.env.ENVIRONMENT,
  release: process.env.GIT_SHA,
};
