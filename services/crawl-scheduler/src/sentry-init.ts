import { initSentry } from 'sentry';
import config from './config.js';

initSentry({ service: config.service });
