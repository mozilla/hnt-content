import { requireInt } from 'crawl-common';

export default {
  port: requireInt('PORT', '8080', 1, 65535),
  tickIntervalMs: requireInt('TICK_INTERVAL_MS', '60000', 1),
  staleTickThresholdMinutes: requireInt(
    'STALE_TICK_THRESHOLD_MINUTES',
    '10',
    1,
  ),
};
