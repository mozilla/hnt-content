// Import from the standalone `sentry` package (not the crawl-common
// barrel) so initialization doesn't pull in the pubsub/zyte module
// graph before Sentry.init runs.
import { initSentry } from 'sentry';
import config from './config.js';

initSentry({ service: config.service });
