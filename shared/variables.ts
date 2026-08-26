/**
 * Global variable types shared between backend and frontend.
 *
 * Global variables are the non-sensitive counterpart to global secrets:
 * plaintext key/value pairs that are stored unencrypted and returned unmasked.
 *
 * @module
 */

/** A single global variable with its plaintext value. */
export interface GlobalVariableEntry {
  /** The variable key (UPPER_SNAKE_CASE). */
  key: string;
  /** The plaintext value. */
  value: string;
  /** Optional description; omitted or empty when unset. */
  description?: string;
  /** Epoch timestamp (ms) of the last update. */
  updatedAt: number;
}
