/**
 * Mutable dispatch table for extension HTTP routes.
 *
 * Elysia cannot add routes once the server is listening, yet extensions are
 * activated, deactivated, and hot-loaded at runtime. The web server therefore
 * mounts a fixed `/ext/*` catch-all once and forwards every request to
 * {@link ExtensionRouter.dispatch}, which matches it against the routes that
 * are currently registered. Routes can be added and removed at any time.
 *
 * The table also records which routes opted out of bearer-token auth
 * (`{ public: true }`); the {@link authCheck} middleware consults
 * {@link ExtensionRouter.isPublic} before demanding a token.
 */

import type { HttpMethod, RouteHandler, RouteOptions } from "@src/extensions/types";
import type { Context } from "elysia";

/** Specificity rank of a single path segment (higher wins). */
const SEGMENT_STATIC = 2;
const SEGMENT_PARAM = 1;
const SEGMENT_WILDCARD = 0;

/** A registered extension route with its compiled matcher. */
interface ExtensionRouteEntry {
  method: HttpMethod;
  path: string;
  pattern: RegExp;
  /** Param names in capture-group order (`*` for a trailing wildcard). */
  paramNames: string[];
  /** Per-segment specificity ranks used to order candidates. */
  ranks: number[];
  handler: RouteHandler;
  options?: RouteOptions;
}

/** Result of matching a request against the table. */
export interface ExtensionRouteMatch {
  route: ExtensionRouteEntry;
  params: Record<string, string>;
}

/**
 * Compiles an Elysia-style path pattern (`/ext/foo/:id`, `/ext/foo/*`) into an
 * anchored regular expression. `:param` captures one non-empty segment and a
 * trailing `*` captures the rest of the path. A trailing slash is optional on
 * both the pattern and the request path (Elysia's default non-strict matching),
 * so a route registered as `"/"` (`/ext/foo/`) also serves `/ext/foo`.
 *
 * @param path - The route path pattern
 * @returns The anchored RegExp, the captured param names, and per-segment specificity ranks
 */
export function compileRoutePattern(path: string): { pattern: RegExp; paramNames: string[]; ranks: number[] } {
  const paramNames: string[] = [];
  const ranks: number[] = [];
  const normalized = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const source = normalized
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        paramNames.push(segment.slice(1));
        ranks.push(SEGMENT_PARAM);
        return "([^/]+)";
      }
      if (segment === "*") {
        paramNames.push("*");
        ranks.push(SEGMENT_WILDCARD);
        return "(.*)";
      }
      ranks.push(SEGMENT_STATIC);
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { pattern: new RegExp(`^${source}/?$`), paramNames, ranks };
}

/**
 * Orders routes so that more specific ones are tried first: segment by
 * segment, static beats `:param` beats `*`; on a tie the longer path wins.
 */
function compareSpecificity(a: ExtensionRouteEntry, b: ExtensionRouteEntry): number {
  const len = Math.min(a.ranks.length, b.ranks.length);
  for (let i = 0; i < len; i++) {
    const diff = (b.ranks[i] ?? 0) - (a.ranks[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return b.ranks.length - a.ranks.length;
}

/** Decodes a captured path segment, falling back to the raw value on malformed escapes. */
function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Converts FormData into a plain object; repeated keys become arrays (Elysia's shape). */
function formDataToObject(form: {
  keys(): Iterable<string>;
  getAll(name: string): unknown[];
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of new Set(form.keys())) {
    const values = form.getAll(key);
    out[key] = values.length > 1 ? values : values[0];
  }
  return out;
}

/** Thrown when a request body cannot be parsed as its declared content type. */
class BodyParseError extends Error {}

/**
 * Parses the request body without consuming the original stream (reads from a
 * clone), so handlers may still call `request.json()` / `request.text()`.
 *
 * @param request - The incoming request
 * @param parse - The route's parse option (`"none"` skips parsing)
 * @returns The parsed body, or undefined when there is none
 * @throws {BodyParseError} If the body is malformed for its content type
 */
async function parseBody(request: Request, parse: RouteOptions["parse"]): Promise<unknown> {
  if (parse === "none" || !request.body || request.method === "GET") return undefined;

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  const kind =
    parse ??
    (contentType.includes("json")
      ? "json"
      : contentType.startsWith("multipart/form-data")
        ? "formdata"
        : contentType.startsWith("application/x-www-form-urlencoded")
          ? "urlencoded"
          : contentType.startsWith("text/")
            ? "text"
            : undefined);
  if (!kind) return undefined;

  const clone = request.clone();
  try {
    switch (kind) {
      case "json":
      case "application/json": {
        const text = await clone.text();
        return text === "" ? undefined : JSON.parse(text);
      }
      case "formdata":
      case "multipart/form-data":
      case "urlencoded":
      case "application/x-www-form-urlencoded":
        return formDataToObject(await clone.formData());
      default:
        return await clone.text();
    }
  } catch (err) {
    throw new BodyParseError(err instanceof Error ? err.message : String(err));
  }
}

/** Runtime route table for extension routes, dispatched through a fixed `/ext/*` mount. */
export class ExtensionRouter {
  /** Routes per method, kept sorted by specificity. */
  readonly #routes = new Map<HttpMethod, ExtensionRouteEntry[]>();

  /**
   * Registers (or replaces) a route.
   *
   * @param method - HTTP method of the route
   * @param path - Full route path pattern (e.g. `/ext/webhooks/receive/:slug`)
   * @param handler - The handler invoked for matching requests
   * @param options - Route options (body parsing, public access)
   */
  add(method: HttpMethod, path: string, handler: RouteHandler, options?: RouteOptions): void {
    this.remove(method, path);
    const { pattern, paramNames, ranks } = compileRoutePattern(path);
    const list = this.#routes.get(method) ?? [];
    list.push({ method, path, pattern, paramNames, ranks, handler, options });
    list.sort(compareSpecificity);
    this.#routes.set(method, list);
  }

  /**
   * Removes a route (no-op if it is not registered).
   *
   * @param method - HTTP method of the route
   * @param path - Full route path pattern as passed to {@link add}
   */
  remove(method: HttpMethod, path: string): void {
    const list = this.#routes.get(method);
    if (!list) return;
    const idx = list.findIndex((r) => r.path === path);
    if (idx !== -1) list.splice(idx, 1);
  }

  /**
   * Finds the most specific route matching a request.
   *
   * @param method - The request's HTTP method (case-insensitive)
   * @param path - The request's URL pathname
   * @returns The matched route and its decoded params, or null
   */
  match(method: string, path: string): ExtensionRouteMatch | null {
    const list = this.#routes.get(method.toUpperCase() as HttpMethod);
    if (!list) return null;
    for (const route of list) {
      const m = route.pattern.exec(path);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = decodeParam(m[i + 1] ?? "");
      });
      return { route, params };
    }
    return null;
  }

  /**
   * Checks whether a request targets a route registered with `{ public: true }`.
   *
   * @param method - The request's HTTP method
   * @param path - The request's URL pathname
   * @returns True when the matching route is public
   */
  isPublic(method: string, path: string): boolean {
    return this.match(method, path)?.route.options?.public === true;
  }

  /**
   * Handles a request from the `/ext/*` mount: matches it, parses the body per
   * the route's options, and invokes the extension handler with `params` and
   * `body` filled in.
   *
   * @param ctx - The Elysia context of the catch-all route
   * @returns The handler's response, a 404 when no route matches, or a 400 for a malformed body
   */
  async dispatch(ctx: Context): Promise<unknown> {
    const { request } = ctx;
    const matched = this.match(request.method, new URL(request.url).pathname);
    if (!matched) return ctx.status(404, { error: "Not found" });

    let body: unknown;
    try {
      body = await parseBody(request, matched.route.options?.parse);
    } catch (err) {
      if (err instanceof BodyParseError) return ctx.status(400, { error: `Invalid request body: ${err.message}` });
      throw err;
    }

    return matched.route.handler({ ...ctx, params: matched.params, body } as Context);
  }
}
