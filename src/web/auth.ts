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

import { BlockList, isIPv6 } from "node:net";
import type { AuthResolver, ResolvedPrincipal } from "@src/auth";
import { TRUSTED_PROXIES } from "@src/config";
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

/** Set of trusted reverse-proxy addresses, matched by {@link clientAddress}. */
export type TrustedProxies = BlockList;

/**
 * Builds the trusted-proxy set from IP/CIDR entries (already validated by config).
 *
 * @param entries - IP addresses or CIDR ranges, e.g. `["127.0.0.1", "172.16.0.0/12"]`.
 * @returns The matcher passed to {@link clientAddress}.
 */
export function createTrustedProxies(entries: readonly string[]): TrustedProxies {
  const list = new BlockList();
  for (const entry of entries) {
    const [addr = "", bits] = entry.split("/");
    const type = isIPv6(addr) ? "ipv6" : "ipv4";
    if (bits === undefined) list.addAddress(addr, type);
    else list.addSubnet(addr, Number(bits), type);
  }
  return list;
}

const defaultTrustedProxies = createTrustedProxies(TRUSTED_PROXIES);

/** Whether an address belongs to a trusted proxy (false for anything unparseable). */
function isTrustedProxy(trusted: TrustedProxies, address: string): boolean {
  try {
    return trusted.check(address, isIPv6(address) ? "ipv6" : "ipv4");
  } catch {
    return false;
  }
}

/**
 * Determines the client address of a request.
 *
 * The TCP peer address is used unless it is a trusted proxy. In that case the
 * `X-Forwarded-For` chain is walked right to left (each proxy appends the
 * address it received the request from) and the first untrusted hop is the
 * client. Entries further left were supplied by the client and are ignored, so
 * a forged header cannot pick an arbitrary address.
 *
 * @param request - The incoming request.
 * @param server - The Bun server (absent when handled in-process, e.g. in tests).
 * @param trusted - Trusted proxies; defaults to the `TRUSTED_PROXIES` config.
 * @returns The client address, or "unknown" when it cannot be determined.
 */
export function clientAddress(
  request: Request,
  server: Server<unknown> | null | undefined,
  trusted: TrustedProxies = defaultTrustedProxies,
): string {
  const peer = server?.requestIP(request)?.address ?? "unknown";
  if (!isTrustedProxy(trusted, peer)) return peer;

  const hops = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i] as string;
    if (!isTrustedProxy(trusted, hop)) return hop;
  }
  // Every hop is a trusted proxy: the leftmost is the closest to the client.
  return hops[0] ?? peer;
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
