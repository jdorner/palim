/**
 * Runtime configuration, loaded from `config.json` next to `index.html`, so a
 * single build works against any Palim server.
 *
 * - `palimUrl`: base URL of the Palim server (e.g. "https://palim.example.com").
 *   Empty means same origin (the portal is served by Palim at `/portal/`, or
 *   the dev server proxies `/api`).
 *
 * @module
 */

/** The portal's runtime configuration. */
export interface PortalConfig {
  /** Base URL of the Palim server, without a trailing slash ("" = same origin). */
  palimUrl: string;
}

let config: PortalConfig = { palimUrl: "" };

/**
 * Loads `config.json`. A missing or invalid file keeps the defaults.
 *
 * @returns The active configuration
 */
export async function loadConfig(): Promise<PortalConfig> {
  try {
    const res = await fetch("./config.json", { cache: "no-store" });
    if (res.ok) {
      const data = (await res.json()) as Partial<PortalConfig>;
      if (typeof data.palimUrl === "string") config = { palimUrl: data.palimUrl.replace(/\/+$/, "") };
    }
  } catch {
    // Defaults apply.
  }
  return config;
}

/**
 * Builds the URL of a Palim API path.
 *
 * @param path - Absolute API path (e.g. "/api/portal/tasks")
 * @returns The full URL
 */
export function apiUrl(path: string): string {
  return `${config.palimUrl}${path}`;
}
