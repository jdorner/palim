/**
 * ACL pattern matching for secrets.
 *
 * Provides wildcard-based consumer identity matching used by the
 * SecretVault's per-row ACL checks.
 *
 * @module
 */

/**
 * Check whether a consumer identity matches an allowed pattern.
 *
 * Supports:
 * - Exact match: `"ext:telegram"` matches `"ext:telegram"`
 * - Wildcard suffix: `"workflow:*"` matches `"workflow:anything"`
 * - Global wildcard: `"*"` matches everything
 *
 * @param consumer - The consumer identity to check
 * @param pattern - The allowed pattern from the ACL
 * @returns True if the consumer matches the pattern
 */
export function matchesPattern(consumer: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern === consumer) return true;

  // Wildcard suffix: "workflow:*" matches "workflow:anything"
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -1); // "workflow:"
    return consumer.startsWith(prefix);
  }

  return false;
}
