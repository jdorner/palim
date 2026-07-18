import assert from "node:assert";
import path, { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const PROJECT_DIR = path.resolve(__dirname, "..");
export const WORK_DIR = (() => {
  assert(process.env.AGENT_WORK_DIR, "AGENT_WORK_DIR environment variable is required");

  const raw = process.env.AGENT_WORK_DIR;
  let expanded = raw;
  if (raw.startsWith("~/")) {
    assert(process.env.HOME, "AGENT_WORK_DIR uses ~ but $HOME is not set");
    expanded = path.join(process.env.HOME, raw.slice(2));
  }

  if (path.isAbsolute(expanded)) {
    return path.resolve(expanded);
  } else {
    return path.resolve(PROJECT_DIR, expanded);
  }
})();
export const API_BASE_URL = process.env.OPENAI_API_BASE_URL || "";

// Default scheme http (use https for reverse-proxy / TLS termination)
const rawScheme = process.env.WEB_SCHEME || "http";
assert(rawScheme === "http" || rawScheme === "https", `Invalid WEB_SCHEME: "${rawScheme}" (must be "http" or "https")`);
export const WEB_SCHEME: "http" | "https" = rawScheme;
// Default host localhost, or use WEB_HOST env variable
export const WEB_HOST = process.env.WEB_HOST ? process.env.WEB_HOST : "localhost";
// Default port 3000, or use WEB_PORT env variable
export const WEB_PORT = process.env.WEB_PORT ? Number.parseInt(process.env.WEB_PORT, 10) : 3000;

/**
 * Returns the server origin (scheme + host + port) with no trailing slash.
 * Wildcard bind addresses (::, 0.0.0.0) are replaced with localhost since
 * they are not valid for outbound requests.
 */
export function serverOrigin(): string {
  const host = WEB_HOST === "::" || WEB_HOST === "0.0.0.0" ? "localhost" : WEB_HOST;
  return `${WEB_SCHEME}://${host}:${WEB_PORT}`;
}

// Extensions directory - configurable via EXTENSIONS_DIR env var
export const EXTENSIONS_DIR = process.env.EXTENSIONS_DIR
  ? path.resolve(process.env.EXTENSIONS_DIR)
  : path.resolve(PROJECT_DIR, "src/extensions");

/**
 * Resolves the data directory for database files (bunqueue.db, palim.db).
 *
 * If `DATA_DIR` is explicitly set in the environment, resolves it as a directory.
 * Otherwise defaults to `<AGENT_WORK_DIR>/.palim/`.
 */
export const DATA_DIR: string = (() => {
  if (process.env.DATA_DIR) {
    return path.resolve(PROJECT_DIR, process.env.DATA_DIR);
  }
  return join(WORK_DIR, ".palim");
})();

/** Directory for dynamically generated/external extensions (e.g. MCP skills). */
export const EXTERNAL_EXTENSIONS_DIR = join(DATA_DIR, "extensions");
