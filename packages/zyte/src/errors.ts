/** Error thrown when a Zyte API request fails. */
export class ZyteError extends Error {
  /** HTTP status code from the Zyte API response. */
  readonly status: number;
  /** Parsed response body, if available. */
  readonly responseBody?: unknown;

  constructor(status: number, message: string, responseBody?: unknown) {
    super(message);
    this.name = 'ZyteError';
    this.status = status;
    this.responseBody = responseBody;
  }
}
