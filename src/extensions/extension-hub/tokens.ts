/**
 * HTTPS access tokens of hub sources, stored in the secret vault as
 * `SOURCE_TOKEN_<source id>` in the extension's own scope.
 *
 * Clearing a token or deleting its source removes the secret (an empty value
 * is never stored), and {@link pruneTokens} removes tokens of sources that no
 * longer exist, for example after a source was deleted while the vault was
 * unavailable.
 *
 * @module
 */

import { HubError } from "./errors";

/** Prefix of the secret keys holding source tokens. */
export const TOKEN_KEY_PREFIX = "SOURCE_TOKEN_";

/** The subset of `ctx.secrets` the token helpers use. */
export interface TokenSecrets {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
  keys(): Promise<string[]>;
}

/**
 * Secret key holding a source's token.
 *
 * @param sourceId - Source id
 * @returns The secret key
 */
export function tokenKey(sourceId: string): string {
  return `${TOKEN_KEY_PREFIX}${sourceId}`;
}

/**
 * Creates the token accessors handed to the hub service.
 *
 * @param secrets - The extension's secret store
 * @returns `getToken` (null when unset or the vault is unavailable) and
 *   `setToken` (null clears; throws 503 when a token cannot be stored)
 */
export function createTokenAccess(secrets: TokenSecrets): {
  getToken: (sourceId: string) => Promise<string | null>;
  setToken: (sourceId: string, token: string | null) => Promise<void>;
} {
  return {
    async getToken(sourceId) {
      try {
        return (await secrets.get(tokenKey(sourceId))) || null;
      } catch {
        return null;
      }
    },
    async setToken(sourceId, token) {
      try {
        if (token) await secrets.set(tokenKey(sourceId), token);
        else await secrets.delete(tokenKey(sourceId));
      } catch (err) {
        // Clearing without a vault is a no-op: nothing can have been stored.
        if (token) {
          throw new HubError(503, `Storing the token needs the secret vault: ${(err as Error).message}`);
        }
      }
    },
  };
}

/**
 * Deletes stored tokens that belong to no existing source or are empty
 * (left by earlier versions, which stored an empty value instead of deleting).
 *
 * @param secrets - The extension's secret store
 * @param sourceIds - Ids of the existing sources
 * @returns The deleted secret keys
 */
export async function pruneTokens(secrets: TokenSecrets, sourceIds: Set<string>): Promise<string[]> {
  const removed: string[] = [];
  for (const key of await secrets.keys()) {
    if (!key.startsWith(TOKEN_KEY_PREFIX)) continue;
    const sourceId = key.slice(TOKEN_KEY_PREFIX.length);
    const orphaned = !sourceIds.has(sourceId);
    if (orphaned || !(await secrets.get(key))) {
      if (await secrets.delete(key)) removed.push(key);
    }
  }
  return removed;
}
