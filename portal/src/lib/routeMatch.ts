/**
 * Route pattern matching (pure, no DOM access).
 *
 * @module
 */

/**
 * Matches a path against a pattern with `:param` segments.
 *
 * @param pattern - e.g. "/tasks/:id"
 * @param path - e.g. "/tasks/abc"
 * @returns The decoded params, or null when the path does not match
 */
export function matchRoute(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const s = path.split("?")[0]!.split("/").filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const part = p[i]!;
    if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(s[i]!);
    else if (part !== s[i]) return null;
  }
  return params;
}
