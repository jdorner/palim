/**
 * Table of extension routes that opted out of bearer-token authentication.
 *
 * Extensions mark a route public by registering it with `{ public: true }`
 * (see {@link RouteOptions.public}). The route registry records the method and
 * Elysia path pattern here, and the {@link authCheck} middleware consults the
 * table before demanding a token. Public routes must authenticate callers
 * themselves (webhook HMAC, OAuth `state` nonce, ...).
 */

import type { HttpMethod } from "@src/extensions/types";

/** A single public route: HTTP method plus the compiled path matcher. */
interface PublicRouteEntry {
  method: HttpMethod;
  pattern: RegExp;
}

/**
 * Compiles an Elysia-style path pattern (`/ext/foo/:id`, `/ext/foo/*`) into an
 * anchored regular expression. `:param` matches one non-empty segment and a
 * trailing `*` matches the rest of the path.
 *
 * @param path - The route path pattern as registered with Elysia
 * @returns An anchored RegExp matching concrete request paths
 */
export function compileRoutePattern(path: string): RegExp {
  const source = path
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) return "[^/]+";
      if (segment === "*") return ".*";
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return new RegExp(`^${source}$`);
}

/** Mutable registry of public routes, shared by the route registry and auth middleware. */
export class PublicRouteTable {
  readonly #entries: PublicRouteEntry[] = [];

  /**
   * Marks a route as public.
   *
   * @param method - HTTP method of the route
   * @param path - Full route path pattern (e.g. `/ext/webhooks/receive/:slug`)
   */
  add(method: HttpMethod, path: string): void {
    this.#entries.push({ method, pattern: compileRoutePattern(path) });
  }

  /**
   * Checks whether a request targets a public route.
   *
   * @param method - The request's HTTP method
   * @param path - The request's URL pathname
   * @returns True when a registered public route matches
   */
  matches(method: string, path: string): boolean {
    const upper = method.toUpperCase();
    return this.#entries.some((entry) => entry.method === upper && entry.pattern.test(path));
  }
}
