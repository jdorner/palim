/**
 * Token-based authentication helpers for the web server.
 * Uses constant-time comparison to prevent timing attacks.
 */

import { timingSafeEqual } from "node:crypto";

/** Whether authentication is enabled (AUTH_TOKEN is set). */
const AUTH_TOKEN = process.env.AUTH_TOKEN ?? "";
export const authEnabled = AUTH_TOKEN.length > 0;
const AUTH_TOKEN_BUFFER = Buffer.from(AUTH_TOKEN);

/**
 * Validates a bearer token against the configured AUTH_TOKEN.
 * Uses constant-time comparison to prevent timing attacks.
 *
 * @param token - The token to validate
 * @returns true if the token matches AUTH_TOKEN
 */
export function validateToken(token: string): boolean {
  if (!authEnabled) return true;
  if (!token) return false;

  const actual = Buffer.from(token);
  if (AUTH_TOKEN_BUFFER.length !== actual.length) return false;
  return timingSafeEqual(AUTH_TOKEN_BUFFER, actual);
}

/**
 * Extracts the bearer token from an Authorization header value.
 *
 * @param header - The Authorization header value (e.g. "Bearer abc123")
 * @returns The token string, or empty string if not a valid Bearer header
 */
export function extractBearerToken(header: string | null | undefined): string {
  if (!header) return "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? "";
}
