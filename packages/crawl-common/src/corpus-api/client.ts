import { importJWK, SignJWT } from 'jose';
import type { JWK } from 'jose';
import pRetry from 'p-retry';
import type {
  ApiApprovedCorpusItem,
  ApiSection,
  CorpusApiClientOptions,
  UpdateApprovedCorpusItemInput,
  UpdateApprovedCorpusItemResponse,
} from './types.js';
import type { CorpusItem, LiveArticle } from '../types/messages.js';

// JWT configuration matching content-ml-services
// admin_backend.py.
const JWT_TTL_SECONDS = 300;
const JWT_REFRESH_BUFFER = 0.95;
const JWT_USERNAME = 'ML';
const JWT_GROUPS = ['mozilliansorg_pocket_scheduled_surface_curator_full'];

/**
 * How long a cached JWT stays fresh before the next call
 * signs a new one.
 */
export const TOKEN_REFRESH_WINDOW_MS =
  JWT_TTL_SECONDS * JWT_REFRESH_BUFFER * 1000;

// 4 retries (5 attempts total) with exponential backoff
// designed to complete well within the 600s Pub/Sub ack
// deadline: ~2s + ~4s + ~8s + ~16s = ~30s worst case.
const MAX_RETRIES = 4;
const RETRY_MIN_TIMEOUT_MS = 2_000;

/** Upper bound on retry delay for Corpus API calls. */
export const RETRY_MAX_TIMEOUT_MS = 16_000;

/** Error thrown when a Corpus Admin API request fails. */
export class CorpusApiError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'CorpusApiError';
  }
}

// Module-level state.
let endpoint: string | undefined;
let clientName = 'hnt-content';
let clientVersion = '1.0';
let privateKey: CryptoKey | Uint8Array;
let kid: string;

// Cached JWT token.
let cachedToken: string | undefined;
let tokenExpiresAt = 0;

// JWT claim config.
let issuer: string;
let audience: string;

/**
 * Initialize the Corpus Admin API client. Must be called
 * once before updateApprovedCorpusItem.
 */
export async function initCorpusApiClient(
  opts: CorpusApiClientOptions,
): Promise<void> {
  endpoint = opts.endpoint;
  issuer = opts.issuer;
  audience = opts.audience;
  clientName = opts.clientName ?? clientName;
  clientVersion = opts.clientVersion ?? clientVersion;

  const jwk = parseJwk(opts.jwkJson);
  kid = jwk.kid!;
  privateKey = await importJWK(jwk, 'RS256');

  // Reset cached token when re-initialized.
  cachedToken = undefined;
  tokenExpiresAt = 0;
}

/**
 * Parse a JWK JSON string, handling the {"keys": [...]}
 * wrapper format used by some secret stores.
 */
function parseJwk(jwkJson: string): JWK {
  const parsed = JSON.parse(jwkJson) as JWK | { keys: JWK[] };
  const jwk =
    'keys' in parsed && Array.isArray(parsed.keys)
      ? parsed.keys[0]
      : (parsed as JWK);
  if (!jwk) {
    throw new Error('JWK keys array is empty');
  }
  if (!jwk.kid) {
    throw new Error('JWK must include a kid field');
  }
  return jwk;
}

/** Get a valid JWT, using the cache when possible. */
async function getToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) {
    return cachedToken;
  }

  cachedToken = await new SignJWT({
    iss: issuer,
    aud: audience,
    name: 'Article Crawler',
    identities: [{ userId: JWT_USERNAME }],
    // Stringified per Cognito convention expected by
    // admin-api JWT validation.
    'custom:groups': JSON.stringify(JWT_GROUPS),
  })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuedAt()
    .setExpirationTime(`${JWT_TTL_SECONDS}s`)
    .sign(privateKey);

  tokenExpiresAt = now + JWT_TTL_SECONDS * JWT_REFRESH_BUFFER * 1_000;
  return cachedToken;
}

/**
 * Execute a GraphQL operation against the Corpus Admin API and return
 * its data payload. Retries transient 5xx and network errors with
 * exponential backoff and fails fast on 4xx and GraphQL errors. label
 * names the operation in error messages.
 */
async function graphqlRequest<T>(
  query: string,
  variables: Record<string, unknown>,
  label: string,
): Promise<T> {
  if (!endpoint) {
    throw new Error(
      'Corpus API client not initialized. ' +
        'Call initCorpusApiClient() first.',
    );
  }

  return pRetry(
    async () => {
      const token = await getToken();
      const response = await fetch(endpoint!, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'apollographql-client-name': clientName,
          'apollographql-client-version': clientVersion,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      });

      if (response.status >= 500) {
        throw new CorpusApiError(
          `Corpus API error: ${response.status} for ${label}`,
          response.status,
        );
      }

      if (response.status >= 400) {
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          // Response may not be JSON.
        }
        throw new CorpusApiError(
          `Corpus API client error: ${response.status} for ${label}: ` +
            JSON.stringify(body),
          response.status,
        );
      }

      const payload = (await response.json()) as {
        data?: T;
        errors?: Array<{ message: string }>;
      };

      if (payload.errors?.length) {
        throw new CorpusApiError(
          `GraphQL errors for ${label}: ` +
            payload.errors.map((e) => e.message).join('; '),
        );
      }

      if (payload.data == null) {
        throw new CorpusApiError(
          `No data returned for ${label}: ${JSON.stringify(payload)}`,
        );
      }

      return payload.data;
    },
    {
      retries: MAX_RETRIES,
      minTimeout: RETRY_MIN_TIMEOUT_MS,
      maxTimeout: RETRY_MAX_TIMEOUT_MS,
      factor: 2,
      shouldRetry({ error }) {
        // Only retry server errors and network failures.
        if (error instanceof CorpusApiError) {
          return error.statusCode != null && error.statusCode >= 500;
        }
        return true; // Network errors.
      },
    },
  );
}

const UPDATE_MUTATION = `
  mutation UpdateApprovedCorpusItem(
    $data: UpdateApprovedCorpusItemInput!
  ) {
    updateApprovedCorpusItem(data: $data) {
      externalId
      url
      title
      excerpt
    }
  }
`;

/**
 * Call the updateApprovedCorpusItem GraphQL mutation.
 * Retries transient HTTP errors (5xx, network) with
 * exponential backoff.
 */
export async function updateApprovedCorpusItem(
  input: UpdateApprovedCorpusItemInput,
): Promise<UpdateApprovedCorpusItemResponse> {
  const data = await graphqlRequest<{
    updateApprovedCorpusItem?: UpdateApprovedCorpusItemResponse;
  }>(UPDATE_MUTATION, { data: input }, `update item ${input.externalId}`);

  if (!data.updateApprovedCorpusItem) {
    throw new CorpusApiError(
      `No data returned for update item ${input.externalId}: ` +
        JSON.stringify(data),
    );
  }
  return data.updateApprovedCorpusItem;
}

const SECTION_ITEMS_QUERY = `
  query GetScheduledSectionItems($scheduledSurfaceGuid: ID!) {
    getSectionsWithSectionItems(scheduledSurfaceGuid: $scheduledSurfaceGuid) {
      status
      sectionItems {
        approvedItem {
          externalId
          url
          title
          excerpt
          authors {
            name
          }
          status
          language
          publisher
          imageUrl
          topic
          isTimeSensitive
        }
      }
    }
  }
`;

/**
 * Fetch the currently scheduled live articles for a New Tab surface via
 * the Corpus Admin API sections query, mirroring the legacy
 * HydrateSectionItems read. Flattens the items of each LIVE section to
 * LiveArticle, de-duplicated by URL (the agent's publisher list requires
 * unique URLs). Non-live sections (scheduled, disabled, expired) are
 * skipped, since the admin query, unlike the public one, does not
 * date-filter. scheduledSurfaceGuid is the bare surface string, e.g.
 * 'NEW_TAB_EN_US'.
 */
export async function getScheduledSectionItems(
  scheduledSurfaceGuid: string,
): Promise<LiveArticle[]> {
  const data = await graphqlRequest<{
    getSectionsWithSectionItems?: ApiSection[];
  }>(
    SECTION_ITEMS_QUERY,
    { scheduledSurfaceGuid },
    `sections for ${scheduledSurfaceGuid}`,
  );

  const seen = new Set<string>();
  const liveArticles: LiveArticle[] = [];
  for (const section of data.getSectionsWithSectionItems ?? []) {
    if (section.status !== 'LIVE') continue;
    for (const { approvedItem } of section.sectionItems ?? []) {
      if (!approvedItem || seen.has(approvedItem.url)) continue;
      seen.add(approvedItem.url);
      liveArticles.push(toLiveArticle(approvedItem));
    }
  }
  return liveArticles;
}

/** Map a Corpus ApprovedCorpusItem to the agent's LiveArticle shape. */
function toLiveArticle(item: ApiApprovedCorpusItem): LiveArticle {
  return {
    url: item.url,
    corpus_item: {
      external_id: item.externalId,
      title: item.title,
      excerpt: item.excerpt,
      authors: item.authors.map((a) => ({ name: a.name })),
      status: item.status as CorpusItem['status'],
      language: item.language as CorpusItem['language'],
      publisher: item.publisher,
      image_url: item.imageUrl,
      topic: item.topic,
      is_time_sensitive: item.isTimeSensitive,
    },
  };
}
