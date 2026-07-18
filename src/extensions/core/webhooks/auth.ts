/**
 * Webhook authentication - HMAC-SHA256 signature verification and
 * bearer token validation with constant-time comparison.
 */

import { timingSafeEqual } from "node:crypto";
import type { WebhookRegistration } from "./types";

/**
 * Verifies the authenticity of an incoming webhook request.
 *
 * For HMAC-SHA256: computes `sha256=<hex>` over the raw body and compares
 * against the signature header using constant-time comparison.
 *
 * For bearer: compares the header value against the stored secret.
 *
 * @param registration - The webhook registration with auth config
 * @param headerValue - The value of the auth header from the request
 * @param rawBody - The raw request body string (used for HMAC computation)
 * @returns true if the request is authentic
 */
export async function verifyAuth(
  registration: WebhookRegistration,
  headerValue: string | null,
  rawBody: string,
): Promise<boolean> {
  if (registration.authType === "none") return true;

  if (!headerValue) return false;

  if (registration.authType === "bearer") {
    const expected = Buffer.from(registration.secret);
    const actual = Buffer.from(headerValue.replace(/^Bearer\s+/i, ""));
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }

  // HMAC-SHA256 verification
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(registration.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expectedHex = `sha256=${Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;

  const expectedBytes = Buffer.from(expectedHex);
  const actualBytes = Buffer.from(headerValue);
  if (expectedBytes.length !== actualBytes.length) return false;
  return timingSafeEqual(expectedBytes, actualBytes);
}
