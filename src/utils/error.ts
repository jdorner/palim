/**
 * Shared error classification utilities for network and LLM connection failures.
 *
 * @module
 */

/** Substrings that indicate the LLM (or any upstream HTTP service) is unreachable. */
const CONNECTION_ERROR_PATTERNS = ["ECONNREFUSED", "fetch failed", "ConnectionRefused"] as const;

/**
 * Checks whether an error message indicates an LLM / upstream connection failure.
 *
 * Matches common Bun/Node network error signatures:
 * - `ECONNREFUSED` - TCP connection refused
 * - `fetch failed` - Bun's generic fetch failure
 * - `ConnectionRefused` - alternative casing seen in some runtimes
 *
 * @param message - The error message string to inspect (may be empty/undefined)
 * @returns `true` if the message matches a known connection-failure pattern
 */
export function isLLMConnectionError(message: string | undefined | null): boolean {
  if (!message) return false;
  return CONNECTION_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}
