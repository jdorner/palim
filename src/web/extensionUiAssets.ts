/**
 * Static file handler for compiled extension UI bundles (`GET /ext-ui/*`).
 *
 * Bundles are produced by the extension UI builder under `EXT_UI_DIR` in
 * content-hashed directories, so responses are cached as immutable. The route
 * is public: browsers load ES modules and stylesheets without a bearer token.
 * Bundles contain only UI code; data is fetched through the authenticated
 * `/ext/<name>/*` routes.
 *
 * @module
 */

import path from "node:path";

/** URL prefix the handler is mounted at. */
const PREFIX = "/ext-ui/";

/** Content types for the file kinds the builder emits. */
const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/**
 * Serves a file from the extension UI output directory.
 *
 * @param pathname - Request path (e.g. `/ext-ui/imap-fetch/<hash>/accounts-x1.js`)
 * @param root - Absolute output directory (`EXT_UI_DIR`)
 * @returns The file response, or 404 for unknown, hidden, or out-of-root paths
 */
export async function serveExtensionUiAsset(pathname: string, root: string): Promise<Response> {
  const notFound = () => new Response("Not found", { status: 404 });
  if (!pathname.startsWith(PREFIX)) return notFound();

  let relative: string;
  try {
    relative = decodeURIComponent(pathname.slice(PREFIX.length));
  } catch {
    return notFound();
  }
  // Reject traversal and hidden entries (e.g. in-progress `.tmp-*` build directories).
  const segments = relative.split("/");
  if (relative.includes("\0") || segments.some((s) => s === "" || s === "." || s === ".." || s.startsWith("."))) {
    return notFound();
  }
  const filePath = path.resolve(root, ...segments);
  if (!filePath.startsWith(`${path.resolve(root)}${path.sep}`)) return notFound();

  const file = Bun.file(filePath);
  if (!(await file.exists())) return notFound();

  return new Response(file, {
    headers: {
      "content-type": CONTENT_TYPES[path.extname(filePath)] ?? file.type,
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}
