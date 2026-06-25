/**
 * Runtime validators for inbound Pub/Sub job messages. The
 * SDK hands us an untyped JSON payload, so we check shape and
 * types at the consumer boundary and fail fast on anything
 * malformed before the handler trusts the static type. There
 * is no schema library in this repo, so the checks are small
 * hand-written guards that throw an explicit error naming the
 * offending field.
 */
import type {
  CorpusItem,
  CrawlArticleMessage,
  CrawlArticleDiscoveryMessage,
  DiscoveryContext,
} from '../types/messages.js';

/**
 * Thrown when an inbound message fails validation. The
 * subscriber nacks the message and reports this under the
 * `validation-error` kind so a poison payload is told apart
 * from a transient handler failure.
 */
export class MessageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessageValidationError';
  }
}

/** Narrow an unknown value to a plain object or throw. */
function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MessageValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Read a required string field. Rejects empty strings unless
 * allowEmpty is set, for fields that may legitimately be blank.
 */
function requireString(
  obj: Record<string, unknown>,
  field: string,
  label: string,
  allowEmpty = false,
): string {
  const value = obj[field];
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    const suffix = allowEmpty ? 'a string' : 'a non-empty string';
    throw new MessageValidationError(`${label}.${field} must be ${suffix}`);
  }
  return value;
}

/** Read a required finite number field. */
function requireNumber(
  obj: Record<string, unknown>,
  field: string,
  label: string,
): number {
  const value = obj[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new MessageValidationError(
      `${label}.${field} must be a finite number`,
    );
  }
  return value;
}

/** Read a required boolean field. */
function requireBoolean(
  obj: Record<string, unknown>,
  field: string,
  label: string,
): boolean {
  const value = obj[field];
  if (typeof value !== 'boolean') {
    throw new MessageValidationError(`${label}.${field} must be a boolean`);
  }
  return value;
}

/** Read a required array field, optionally requiring it non-empty. */
function requireArray(
  obj: Record<string, unknown>,
  field: string,
  label: string,
  nonEmpty = false,
): unknown[] {
  const value = obj[field];
  if (!Array.isArray(value)) {
    throw new MessageValidationError(`${label}.${field} must be an array`);
  }
  if (nonEmpty && value.length === 0) {
    throw new MessageValidationError(`${label}.${field} must not be empty`);
  }
  return value;
}

/** Validate an authors array of { name } objects. */
function validateAuthors(value: unknown[], label: string): { name: string }[] {
  return value.map((entry, i) => {
    const author = asObject(entry, `${label}[${i}]`);
    return { name: requireString(author, 'name', `${label}[${i}]`) };
  });
}

/** Validate the corpus_item present on live-article messages. */
function validateCorpusItem(value: unknown): CorpusItem {
  const label = 'corpus_item';
  const obj = asObject(value, label);
  return {
    external_id: requireString(obj, 'external_id', label),
    title: requireString(obj, 'title', label),
    // Excerpt is curator free text and may be blank.
    excerpt: requireString(obj, 'excerpt', label, true),
    authors: validateAuthors(
      requireArray(obj, 'authors', label),
      `${label}.authors`,
    ),
    // status and language are typed as unions; we check the
    // string shape here and trust the producing agent for the
    // exact value rather than rejecting newly added languages.
    status: requireString(obj, 'status', label) as CorpusItem['status'],
    language: requireString(obj, 'language', label) as CorpusItem['language'],
    publisher: requireString(obj, 'publisher', label),
    image_url: requireString(obj, 'image_url', label),
    topic: requireString(obj, 'topic', label),
    is_time_sensitive: requireBoolean(obj, 'is_time_sensitive', label),
  };
}

/**
 * Validate a crawl-article message. Requires the routing
 * fields and, for live articles, a well-formed corpus_item.
 */
export function validateCrawlArticleMessage(raw: unknown): CrawlArticleMessage {
  const label = 'crawl-article message';
  const obj = asObject(raw, label);
  const message: CrawlArticleMessage = {
    url: requireString(obj, 'url', label),
    source_url: requireString(obj, 'source_url', label),
    crawl_id: requireString(obj, 'crawl_id', label),
    enqueued_at: requireString(obj, 'enqueued_at', label),
  };
  if (obj.corpus_item != null) {
    message.corpus_item = validateCorpusItem(obj.corpus_item);
  }
  return message;
}

/** Validate a single discovery context of surface_id + topic. */
function validateContext(value: unknown, label: string): DiscoveryContext {
  const obj = asObject(value, label);
  return {
    surface_id: requireString(obj, 'surface_id', label),
    topic: requireString(obj, 'topic', label),
  };
}

/**
 * Validate a crawl-article-discovery message. Requires the
 * page url, a positive crawl interval, and at least one context.
 * Fields are checked in declaration order so the first error
 * names the earliest offending top-level field.
 */
export function validateCrawlArticleDiscoveryMessage(
  raw: unknown,
): CrawlArticleDiscoveryMessage {
  const label = 'crawl-article-discovery message';
  const obj = asObject(raw, label);
  const url = requireString(obj, 'url', label);
  const interval_minutes = requireNumber(obj, 'interval_minutes', label);
  // A non-positive interval would make every page look perpetually
  // stale to the discovery worker, so reject it at the boundary.
  if (interval_minutes <= 0) {
    throw new MessageValidationError(
      `${label}.interval_minutes must be a positive number`,
    );
  }
  const contexts = requireArray(obj, 'contexts', label, true).map((c, i) =>
    validateContext(c, `${label}.contexts[${i}]`),
  );
  return { url, interval_minutes, contexts };
}
