import { initMetrics } from 'metrics';
import config from './config.js';

initMetrics({ service: config.service, workerRole: config.workerRole });
