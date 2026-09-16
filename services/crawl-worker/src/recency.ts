import { getTimestamp } from 'redis-state';

/**
 * Return whether the fetch marker at key was written within the last
 * `minutes`. The article and discovery steps call this before paying
 * for a Zyte extraction, so a page or article that was crawled inside
 * its refresh window is skipped. A missing marker reads as not recent.
 */
export async function withinMinutes(
  key: string,
  minutes: number,
): Promise<boolean> {
  const markedAt = await getTimestamp(key);

  return markedAt !== null && Date.now() - markedAt < minutes * 60_000;
}
