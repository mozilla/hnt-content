/**
 * Pick at most `limit` of the items at random. Both enqueuers cap what
 * a tick sends, and while this service is under development a random
 * subset is the simplest way to limit how many Zyte requests we make.
 */
export function randomBatch<T>(items: T[], limit: number): T[] {
  return items
    .map((item) => ({ item, order: Math.random() }))
    .sort((a, b) => a.order - b.order)
    .slice(0, limit)
    .map(({ item }) => item);
}
