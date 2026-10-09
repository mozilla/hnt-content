import { getTimestamp } from 'redis-state';

/**
 * Return whether the fetch/crawl marker at key was set within the last
 * `minutes`, so the worker can skip a page or article it processed
 * recently.
 */
export async function withinMinutes(
  key: string,
  minutes: number,
): Promise<boolean> {
  const markedAt = await getTimestamp(key);
  return markedAt !== null && Date.now() - markedAt < minutes * 60_000;
}
