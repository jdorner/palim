/**
 * Pure path helpers for extension pages (no router or DOM dependencies).
 *
 * @module
 */

import type { PalimPageRoute } from "$shared/extensionUi";

/**
 * Splits an app path (`/ext-page/<ext>/<page>/<sub>?<query>`) into the page's
 * sub-path and query.
 *
 * @param appPath - The current hash route
 * @param pageRoute - The page's base route (`/ext-page/<ext>/<page>`)
 * @returns The page route state
 */
export function parsePageRoute(appPath: string, pageRoute: string): PalimPageRoute {
  const [rawPath = "", rawQuery = ""] = appPath.split("?", 2);
  let path = "";
  if (rawPath === pageRoute || rawPath.startsWith(`${pageRoute}/`)) {
    path = rawPath
      .slice(pageRoute.length)
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      })
      .join("/");
  }
  return { path, query: new URLSearchParams(rawQuery) };
}

/**
 * Resolves a page-relative request path: `/api/...` and `/ext/...` are used as
 * is, anything else is relative to the extension's routes.
 *
 * @param extensionName - Owning extension
 * @param path - Requested path
 * @returns The absolute request path
 */
export function resolveExtensionPath(extensionName: string, path: string): string {
  if (path.startsWith("/api/") || path.startsWith("/ext/")) return path;
  return `/ext/${extensionName}${path.startsWith("/") ? "" : "/"}${path}`;
}
