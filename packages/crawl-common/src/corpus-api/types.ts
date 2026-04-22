/** Options for configuring the Corpus Admin API client. */
export interface CorpusApiClientOptions {
  /**
   * Admin API GraphQL endpoint (e.g.
   * 'https://admin-api.getpocket.com/').
   */
  endpoint: string;
  /** JWK JSON string containing the RSA private key. */
  jwkJson: string;
  /** JWT issuer claim. */
  issuer: string;
  /** JWT audience claim. */
  audience: string;
  /**
   * apollographql-client-name header value. Identifies
   * this service in admin-api logs.
   */
  clientName?: string;
  /** apollographql-client-version header value. */
  clientVersion?: string;
}

/** Input for the updateApprovedCorpusItem GraphQL mutation. */
export interface UpdateApprovedCorpusItemInput {
  externalId: string;
  title: string;
  excerpt: string;
  authors: Array<{ name: string; sortOrder: number }>;
  status: 'CORPUS' | 'RECOMMENDATION';
  language: 'EN' | 'DE' | 'ES' | 'FR' | 'IT';
  publisher: string;
  imageUrl: string;
  topic: string;
  isTimeSensitive: boolean;
  datePublished?: string;
}

/** Subset of fields returned by the mutation. */
export interface UpdateApprovedCorpusItemResponse {
  externalId: string;
  url: string;
  title: string;
  excerpt: string;
}
