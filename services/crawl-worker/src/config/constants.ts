/**
 * config constants must be kept in a separate file to be imported into test
 * files without triggering execution of the config module.
 *
 * additional comments/explanations on values are in the config.ts file.
 */

// minimum seconds for the crawl worker to acknowledge a message
export const ACK_DEADLINE_SECONDS_MIN = 30;
// default seconds to acknowledge a message (can be overriden in env)
export const ACK_DEADLINE_SECONDS_DEFAULT = 300;
// re-fetch window for an article
export const ARTICLE_FETCH_TTL_MINUTES_DEFAULT = 60;
// Lock TTL must clear just before redelivery, so it tracks the ack
// deadline rather than the longer max extension.
export const LOCK_TTL_ACK_SECONDS_DELTA = 30;
export const APP_PORT_DEFAULT = 8080;
// Cap on outstanding (leased but unacked) Pub/Sub messages, mapped
// to the SDK's flowControl.maxMessages. Bounds concurrent handlers,
// and so the concurrent Zyte fetches and response bodies held in
// memory. The SDK default of 1000 OOM-kills the worker under a
// backlog, so we cap it low. Raise once the pod has more memory or
// an in-process Zyte cap exists.
export const PUBSUB_MAX_MESSAGES_DEFAULT = 64;
export const REDIS_PORT_DEFAULT = 6379;
export const ZYTE_RATE_LIMIT_BURST_DEFAULT = 0;
export const ZYTE_RATE_LIMIT_MAX_WAIT_MS_DEFAULT = 30_000;
export const ZYTE_RATE_LIMIT_PER_MINUTE_ARTICLE = 2200;
export const ZYTE_RATE_LIMIT_PER_MINUTE_DISCOVERY = 300;
