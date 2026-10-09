/**
 * Data Tables error type carrying an HTTP status.
 *
 * @module
 */

/** An error raised by the data table store, mapped to an HTTP status by the routes. */
export class DataTableError extends Error {
  /** HTTP status code (400 invalid input, 404 not found, 409 conflict). */
  readonly status: number;
  /** Optional structured details (e.g. per-row errors). */
  readonly details?: unknown;

  /**
   * @param status - HTTP status code
   * @param message - Human-readable message
   * @param details - Optional structured details
   */
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "DataTableError";
    this.status = status;
    this.details = details;
  }
}
