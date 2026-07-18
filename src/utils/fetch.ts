/**
 * Authenticated fetch utility for internal API calls.
 *
 * Creates a fetch wrapper that automatically injects the Authorization header
 * for requests targeting the local server origin. External requests pass through
 * unmodified.
 *
 * Used by both the extension context and skill script loader.
 */

import { serverOrigin } from "@src/config";

/**
 * Creates an authenticated fetch wrapper that injects the Authorization
 * header for requests targeting the local server origin. External requests
 * pass through unmodified.
 *
 * The token is read from process.env.AUTH_TOKEN (loaded by dotenvx.config()
 * at boot).
 *
 * @returns A fetch function with automatic auth for internal requests
 */
export function createAuthenticatedFetch(): typeof globalThis.fetch {
  const token = process.env.AUTH_TOKEN ?? "";
  const origin = serverOrigin();

  const wrapper = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    if (token && url.startsWith(origin)) {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${token}`);
      return globalThis.fetch(input, { ...init, headers });
    }
    return globalThis.fetch(input, init);
  };
  return wrapper as typeof globalThis.fetch;
}

/** Shared authenticated fetch instance - created once, reused process-wide. */
export const authenticatedFetch = createAuthenticatedFetch();
