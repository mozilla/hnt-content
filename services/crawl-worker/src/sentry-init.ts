import { initSentry } from 'sentry';
import config from './config/index.js';

initSentry({ service: config.service });
