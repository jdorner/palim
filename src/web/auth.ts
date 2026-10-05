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

import type { AuthResolver, ResolvedPrincipal } from "@src/auth";
import type { Server } from "bun";

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
 * Per-request cache of token resolution results (including failures), so the
 * rate limiter and the auth check resolve each request's token only once.
 */
const resolved = new WeakMap<Request, ResolvedPrincipal | null>();

/**
 * Resolves the request's bearer token to a principal, memoized per request.
 *
 * @param request - The incoming request.
 * @param resolver - The resolver mapping tokens to principals.
 * @returns The resolved principal, or null when the token is missing or invalid.
 */
export function resolveRequestPrincipal(request: Request, resolver: AuthResolver): ResolvedPrincipal | null {
  const cached = resolved.get(request);
  if (cached !== undefined) return cached;
  const principal = resolver.resolveToken(extractBearerToken(request.headers.get("authorization")));
  resolved.set(request, principal);
  return principal;
}

/**
 * Determines the client address of a request.
 *
 * @param request - The incoming request.
 * @param server - The Bun server (absent when handled in-process, e.g. in tests).
 * @returns The peer address, or "unknown" when it cannot be determined.
 */
export function clientAddress(request: Request, server: Server<unknown> | null | undefined): string {
  return server?.requestIP(request)?.address ?? "unknown";
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
