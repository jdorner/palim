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
 *   `setToken` (null clears; throws 503 when a token cannot be stored or a
 *   stored token cannot be deleted)
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
      const key = tokenKey(sourceId);
      if (token) {
        try {
          await secrets.set(key, token);
        } catch (err) {
          throw new HubError(503, `Storing the token needs the secret vault: ${(err as Error).message}`);
        }
        return;
      }
      try {
        // Without a vault `keys()` is empty, so clearing is a no-op only when
        // nothing is stored; any failure to delete a stored token propagates.
        if ((await secrets.keys()).includes(key)) await secrets.delete(key);
      } catch (err) {
        throw new HubError(503, `The token could not be cleared: ${(err as Error).message}`);
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
