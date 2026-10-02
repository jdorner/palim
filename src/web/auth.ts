/**
 * Request authentication helpers for the web server.
 *
 * The legacy shared `AUTH_TOKEN` gate has been replaced by per-user
 * authentication: a bearer token is resolved to an authenticated principal by
 * the {@link import("@src/auth").AuthResolver}. This module provides token
 * extraction and a request-scoped principal registry so route handlers can read
 * the authenticated identity resolved by the central auth check.
 *
 * @module
 */

import type { ResolvedPrincipal } from "@src/auth";

/** WebSocket auth protocol prefix - clients send the token as `auth-<token>`. */
export const WS_AUTH_PREFIX = "auth-";

/**
 * Request-scoped registry of resolved principals.
 *
 * Keyed by the incoming `Request` object (unique per request), so a handler can
 * retrieve the identity that the central auth check resolved without threading
 * it through every route signature. Entries are garbage-collected with the
 * request via the WeakMap.
 */
const principals = new WeakMap<Request, ResolvedPrincipal>();

/**
 * Associates a resolved principal with the current request.
 *
 * @param request - The incoming request.
 * @param principal - The principal resolved from the bearer token.
 */
export function setPrincipal(request: Request, principal: ResolvedPrincipal): void {
  principals.set(request, principal);
}

/**
 * Retrieves the resolved principal for the current request.
 *
 * @param request - The incoming request.
 * @returns The resolved principal, or undefined when the request is unauthenticated.
 */
export function getPrincipal(request: Request): ResolvedPrincipal | undefined {
  return principals.get(request);
}

/**
 * Extracts the bearer token from an Authorization header value.
 *
 * @param header - The Authorization header value (e.g. "Bearer abc123").
 * @returns The token string, or empty string if not a valid Bearer header.
 */
export function extractBearerToken(header: string | null | undefined): string {
  if (!header) return "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? "";
}

/**
 * Extracts an auth token from a WebSocket `Sec-WebSocket-Protocol` header.
 *
 * Clients send the token as a sub-protocol in the format `auth-<token>` because
 * browsers cannot set arbitrary WebSocket headers.
 *
 * @param protocolHeader - Raw `Sec-WebSocket-Protocol` header value.
 * @returns The extracted token, or empty string if none found.
 */
export function extractWsToken(protocolHeader: string | null): string {
  if (!protocolHeader) return "";
  const authProtocol = protocolHeader
    .split(",")
    .map((p) => p.trim())
    .find((p) => p.startsWith(WS_AUTH_PREFIX));
  return authProtocol?.slice(WS_AUTH_PREFIX.length) ?? "";
}
