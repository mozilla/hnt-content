import { setTimeout as delay } from 'node:timers/promises';
import { acquireRateLimitToken } from 'crawl-common';
import config from './config.js';

// Each worker role gets its own bucket. The two per-role rates sum to
// the per-account Zyte limit, so the roles neither contend on one bucket
// nor starve each other. Redis is per-environment, so the key is not
// env-prefixed.
const RATE_LIMIT_KEY = `zyte:rate-limit:${config.workerRole}`;

/**
 * Wait for a shared Zyte rate-limit token, retrying as the bucket
 * refills. Throws once the max wait elapses so the message nacks and
 * redelivers, shedding load when Zyte is saturated rather than holding
 * a worker indefinitely. Returns immediately when rate limiting is
 * disabled (perMinute <= 0). Burst defaults to one minute of tokens.
 */
export async function awaitZyteToken(): Promise<void> {
  const ratePerMinute = config.zyteRateLimitPerMinute;
  if (ratePerMinute <= 0) return;
  const burst = config.zyteRateLimitBurst || ratePerMinute;
  const deadline = Date.now() + config.zyteRateLimitMaxWaitMs;
  for (;;) {
    const { allowed, retryAfterMs } = await acquireRateLimitToken(
      RATE_LIMIT_KEY,
      ratePerMinute,
      burst,
    );
    if (allowed) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error('Zyte rate limit exceeded; retry later');
    }
    await delay(Math.min(retryAfterMs, remaining));
  }
}
