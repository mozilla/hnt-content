/**
 * Return whether a marker timestamp falls within the last `minutes`, so
 * the worker can skip a page or article it processed recently.
 */
export function isWithinMinutes(
  timestamp: number | null,
  minutes: number,
): boolean {
  return timestamp !== null && Date.now() - timestamp < minutes * 60_000;
}
