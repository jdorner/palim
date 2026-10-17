/**
 * Implementation of `ctx.internal.identity` on top of the user store and the
 * process-wide identity minter.
 *
 * @module
 */

import { registerTriggerOwnerCounter } from "@src/web/triggerOwnership";
import { mintIdentityToken } from "./identityMinter";
import type { IdentityApi } from "./identityTypes";
import type { UserRecord } from "./userStore";

/** Default lifetime of a token minted through {@link IdentityApi.mintToken} (1 hour). */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

/** The user lookups the identity API needs (structurally satisfied by `UserStore`). */
export interface IdentityUserLookup {
  /** Looks up a user by username. */
  getUserByUsername(username: string): UserRecord | undefined;
  /** Looks up a user by id. */
  getUserById(id: string): UserRecord | undefined;
  /** Lists all users. */
  listUsers(): UserRecord[];
}

/**
 * Creates the identity API handed to extensions.
 *
 * @param users - User lookups (the core `UserStore`)
 * @param mint - Token minter (defaults to the process-wide {@link mintIdentityToken})
 * @returns The {@link IdentityApi}
 */
export function createIdentityApi(
  users: IdentityUserLookup,
  mint: (userId: string, ttlMs?: number) => string | null = mintIdentityToken,
): IdentityApi {
  const isUsable = (user: UserRecord | undefined): user is UserRecord =>
    user !== undefined && !user.disabled && user.kind === "operator";

  return {
    listOperatorUsernames() {
      return users
        .listUsers()
        .filter(isUsable)
        .map((u) => u.username)
        .sort((a, b) => a.localeCompare(b));
    },

    mintToken(username, ttlMs) {
      const user = users.getUserByUsername(username);
      if (!isUsable(user)) return null;
      return mint(user.id, ttlMs ?? DEFAULT_TTL_MS);
    },

    registerOwnerCounter(kind, counter) {
      return registerTriggerOwnerCounter(kind, (userId) => {
        const user = users.getUserById(userId);
        return user ? counter(user.username) : 0;
      });
    },
  };
}
