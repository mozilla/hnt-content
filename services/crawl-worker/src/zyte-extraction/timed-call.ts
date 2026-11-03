import { duration, type Outcome } from 'metrics';
import { ZyteError } from 'zyte';

// Zyte averages about 9s per call, and the client gives up after 90s.
const ZYTE_BUCKETS = [0.5, 1, 2, 5, 10, 20, 30, 60, 90];

/**
 * Run a Zyte call and record its duration, including the client's
 * retries. Zyte bills only successful calls, so the success count
 * tracks spend.
 */
export async function timeZyteCall<T>(
  itemType: 'article' | 'live_article' | 'article_list',
  call: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  let outcome: Outcome = 'failure';
  let errorType: string | undefined;
  try {
    const result = await call();
    outcome = 'success';
    return result;
  } catch (err) {
    errorType = err instanceof ZyteError ? String(err.status) : 'other';
    throw err;
  } finally {
    duration(
      'crawl_zyte_request_duration',
      (performance.now() - start) / 1000,
      ZYTE_BUCKETS,
      { item_type: itemType, outcome, error_type: errorType },
    );
  }
}
