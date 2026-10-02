/**
 * Identity-carrying, optionally prefix-confined fetch for internal API calls.
 *
 * The legacy implementation injected a single shared `AUTH_TOKEN` for any
 * request to the local origin, and was handed unwrapped to extensions and skill
 * sandbox programs. That is a confused-deputy hazard: a low-privilege caller who
 * can influence such a request borrows the shared identity's authority.
 *
 * This module instead builds fetch wrappers bound to a specific principal's
 * token (supplied lazily by a token provider, so per-job identities can be
 * threaded in) and, when a `prefix` is given, confines local-origin requests to
 * that extension's own route namespace (plus a small allowlist such as the push
 * endpoint). Internal calls therefore authenticate AND authorize as the bound
 * principal, and cannot reach arbitrary privileged endpoints.
 *
 * @module
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { serverOrigin } from "@src/config";

/**
 * Supplies the bearer token to attach to internal requests.
 *
 * Returns an empty string when no token is available (e.g. before the system
 * token is minted at boot), in which case no Authorization header is added and
 * the downstream auth check will reject the call.
 */
export type TokenProvider = () => string;

/** Options for {@link createInternalFetch}. */
export interface InternalFetchOptions {
  /** Supplies the bearer token to attach for local-origin requests. */
  tokenProvider: TokenProvider;
  /**
   * When set, local-origin requests are confined to this path prefix (e.g.
   * `/ext/telegram`). Requests to other local paths are refused. External-origin
   * requests are always allowed and never carry the token.
   */
  prefix?: string;
  /**
   * Additional local path prefixes allowed regardless of {@link prefix} (e.g.
   * `/api/push` for skill programs). Defaults to `["/api/push"]`.
   */
  allowExtraPrefixes?: string[];
}

/** Default local paths a confined fetch may reach beyond its own extension prefix. */
const DEFAULT_EXTRA_PREFIXES = ["/api/push"];

/**
 * Extracts the pathname of a request input, or null when it is not a
 * local-origin URL we should confine/authenticate.
 *
 * @param input - The fetch input.
 * @param origin - The local server origin.
 * @returns The pathname when the URL targets the local origin, else null.
 */
function localPathname(input: string | URL | Request, origin: string): string | null {
  const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
  if (!url.startsWith(origin)) return null;
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/**
 * Whether a local pathname is within the confined prefix set.
 *
 * @param pathname - The request pathname.
 * @param prefix - The extension's own prefix.
 * @param extra - Additional allowed prefixes.
 * @returns True when the path is allowed for a confined fetch.
 */
function isWithinPrefix(pathname: string, prefix: string, extra: string[]): boolean {
  const allowed = [prefix, ...extra];
  return allowed.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Creates an internal fetch wrapper bound to a principal's token.
 *
 * For local-origin requests it injects `Authorization: Bearer <token>` from the
 * provider. When `prefix` is set, local-origin requests outside the confined
 * prefixes are refused with a 403 Response (never reaching the network), which
 * closes the confused-deputy path: a skill/extension cannot call arbitrary
 * privileged endpoints even if it holds the handle. External requests pass
 * through unmodified and never carry the token.
 *
 * @param opts - Token provider, optional confinement prefix, and extra allowlist.
 * @returns A `fetch`-compatible function.
 */
export function createInternalFetch(opts: InternalFetchOptions): typeof globalThis.fetch {
  const origin = serverOrigin();
  const extra = opts.allowExtraPrefixes ?? DEFAULT_EXTRA_PREFIXES;

  const wrapper = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const pathname = localPathname(input, origin);

    // External request: pass through untouched, no token.
    if (pathname === null) {
      return globalThis.fetch(input, init);
    }

    // Confinement: refuse local-origin calls outside the allowed prefixes.
    if (opts.prefix && !isWithinPrefix(pathname, opts.prefix, extra)) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: "Forbidden: internal fetch confined to extension routes" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    const token = opts.tokenProvider();
    if (!token) {
      // No identity available: send without auth (downstream will 401).
      return globalThis.fetch(input, init);
    }
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return globalThis.fetch(input, { ...init, headers });
  };

  return wrapper as typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// System (background/boot) token
// ---------------------------------------------------------------------------

/**
 * Process-wide provider for the narrow `system` principal's token.
 *
 * Installed once at boot via {@link setSystemToken}. Boot installs a provider
 * that mints (and caches) short-lived tokens on demand, so the system token
 * renews itself instead of expiring after a fixed lifetime. Genuine
 * system-initiated background calls (with no originating user) use
 * {@link systemFetch}, which reads this.
 */
let _systemTokenProvider: TokenProvider = () => "";

/**
 * Sets the process-wide system token used for background/boot internal calls.
 *
 * @param token - A fixed system-principal bearer token, or a provider returning
 *   the current one (empty string when unavailable).
 */
export function setSystemToken(token: string | TokenProvider): void {
  _systemTokenProvider = typeof token === "function" ? token : () => token;
}

/** Token provider that returns the current system token. */
const systemTokenProvider: TokenProvider = () => _systemTokenProvider();

/**
 * Shared fetch for genuine system-initiated internal calls (no originating
 * user). Not confined to a prefix, but bound to the narrow `system` principal,
 * whose ability lacks privileged permissions (never users:manage).
 */
export const systemFetch: typeof globalThis.fetch = createInternalFetch({ tokenProvider: systemTokenProvider });

// ---------------------------------------------------------------------------
// Ambient per-job identity
// ---------------------------------------------------------------------------

/** The identity bound to a job for the duration of its processing. */
interface AmbientIdentity {
  /** The initiating principal's bearer token. */
  token: string;
  /** The initiating user's id, when known. */
  userId?: string;
}

/**
 * Async-scoped storage carrying the initiating user's identity for the duration
 * of a job (agent/chat/workflow step). Job processors run their body inside
 * {@link runWithIdentity} so that any internal fetch made during processing -
 * including from skills and extension `ctx.fetch` - authorizes as the initiating
 * user rather than a shared privileged identity, and so that work spawned from
 * the job (e.g. a workflow started by a `start-workflow` step) inherits the
 * same initiator.
 */
const identityStorage = new AsyncLocalStorage<AmbientIdentity>();

/**
 * Runs a function with an ambient identity in scope.
 *
 * Any internal fetch performed within `fn` (synchronously or across awaits)
 * uses `token` for authorization via {@link resolveAmbientToken}, and
 * {@link resolveAmbientUserId} reports `userId`.
 *
 * @param token - The initiating principal's bearer token.
 * @param fn - The function to run within the identity scope.
 * @param userId - The initiating user's id, so spawned work can inherit it.
 * @returns The function's return value.
 */
export function runWithIdentity<T>(token: string, fn: () => T, userId?: string): T {
  return identityStorage.run(userId ? { token, userId } : { token }, fn);
}

/**
 * Resolves the token an internal call should carry.
 *
 * Prefers the ambient per-job identity (set by {@link runWithIdentity}); when
 * none is in scope (genuine background/boot work), falls back to the narrow
 * system token.
 *
 * @returns The bearer token to attach, or an empty string when none is available.
 */
export function resolveAmbientToken(): string {
  return identityStorage.getStore()?.token ?? _systemTokenProvider();
}

/**
 * Resolves the id of the user whose job is currently being processed.
 *
 * @returns The ambient initiating user id, or undefined for system/background work.
 */
export function resolveAmbientUserId(): string | undefined {
  return identityStorage.getStore()?.userId;
}
