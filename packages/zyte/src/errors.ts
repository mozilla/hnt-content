/** Error thrown when a Zyte API request fails. */
export class ZyteError extends Error {
  /** HTTP status code from the Zyte API response. */
  readonly status: number;
  /** URL Zyte was asked to extract. */
  readonly url?: string;
  /**
   * Zyte's response body, captured for Sentry and the logs. Its shape
   * is not known ahead of time, so the type is unknown.
   */
  readonly responseBody?: unknown;

  /**
   * Keep the message free of the URL and body, which go in their own
   * fields, so Sentry can group errors by message.
   */
  constructor(
    status: number,
    message: string,
    details: { url?: string; responseBody?: unknown } = {},
  ) {
    super(message);
    this.name = 'ZyteError';
    this.status = status;
    this.url = details.url;
    this.responseBody = details.responseBody;
  }
}
