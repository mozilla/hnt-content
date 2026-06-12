// Imports from the narrow `crawl-common/sentry` sub-path so this
// module's evaluation doesn't pull in pubsub/zyte/corpus-api
// before Sentry.init runs.
import { initSentry } from 'crawl-common/sentry';
import config from './config.js';

initSentry({ service: config.service });
