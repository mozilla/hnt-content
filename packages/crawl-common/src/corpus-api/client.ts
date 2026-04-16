import { importJWK, SignJWT } from 'jose';
import type { JWK } from 'jose';
import pRetry from 'p-retry';
import type {
  CorpusApiClientOptions,
  UpdateApprovedCorpusItemInput,
  UpdateApprovedCorpusItemResponse,
} from './types.js';

// JWT configuration matching content-ml-services
// admin_backend.py.
const JWT_TTL_SECONDS = 300;
const JWT_REFRESH_BUFFER = 0.95;
const JWT_USERNAME = 'ML';
const JWT_GROUPS = ['mozilliansorg_pocket_scheduled_surface_curator_full'];

// Retry configuration. 4 attempts with exponential backoff
// designed to complete well within the 600s Pub/Sub ack
// deadline: ~2s + ~4s + ~8s + ~16s = ~30s worst case.
const RETRY_ATTEMPTS = 4;
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
      ? parsed.keys[0]!
      : (parsed as JWK);
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
    'custom:groups': JSON.stringify(JWT_GROUPS),
  })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuedAt()
    .setExpirationTime(`${JWT_TTL_SECONDS}s`)
    .sign(privateKey);

  tokenExpiresAt = now + JWT_TTL_SECONDS * JWT_REFRESH_BUFFER * 1_000;
  return cachedToken;
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
        body: JSON.stringify({
          query: UPDATE_MUTATION,
          variables: { data: input },
        }),
      });

      if (response.status >= 500) {
        throw new CorpusApiError(
          `Corpus API error: ${response.status} for ` +
            `item ${input.externalId}`,
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
          `Corpus API client error: ${response.status} ` +
            `for item ${input.externalId}: ` +
            JSON.stringify(body),
          response.status,
        );
      }

      const payload = (await response.json()) as {
        data?: {
          updateApprovedCorpusItem: UpdateApprovedCorpusItemResponse;
        };
        errors?: Array<{ message: string }>;
      };

      if (payload.errors?.length) {
        throw new CorpusApiError(
          `GraphQL errors for item ${input.externalId}: ` +
            payload.errors.map((e) => e.message).join('; '),
        );
      }

      return payload.data!.updateApprovedCorpusItem;
    },
    {
      retries: RETRY_ATTEMPTS,
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
