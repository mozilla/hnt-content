import * as Sentry from '@sentry/node';
import { initSentry } from 'sentry';
import config from './config.js';

initSentry({ service: config.service });
// Tag every event from this pod, including Pub/Sub's own errors.
Sentry.getGlobalScope().setTag('worker_role', config.workerRole);
