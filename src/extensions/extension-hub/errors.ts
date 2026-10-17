/**
 * Extension Hub error type carrying an HTTP status.
 *
 * @module
 */

/** An error raised by the hub, mapped to an HTTP status by the routes. */
export class HubError extends Error {
  /** HTTP status code (400 invalid input, 404 not found, 409 conflict, 422 not installable, 502 git failure). */
  readonly status: number;
  /** Optional structured details. */
  readonly details?: unknown;

  /**
   * @param status - HTTP status code
   * @param message - Human-readable message
   * @param details - Optional structured details
   */
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "HubError";
    this.status = status;
    this.details = details;
  }
}
