/**
 * Implementation of `ctx.internal.identity` on top of the user store and the
 * process-wide identity minter. One instance per extension, so minted tokens
 * are logged with the extension's name and owner counters live in that
 * extension's namespace.
 *
 * @module
 */

import { ROLE_ADMIN, ROLE_SYSTEM } from "@shared/auth";
import { registerTriggerOwnerCounter } from "@src/web/triggerOwnership";
import { SYSTEM_USERNAME } from "./constants";
import { mintIdentityToken } from "./identityMinter";
import type { IdentityApi } from "./identityTypes";
import type { UserRecord } from "./userStore";

/** Default lifetime of a token minted through {@link IdentityApi.mintToken} (1 hour). */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

/** Roles an extension may never act as. */
const PRIVILEGED_ROLES: readonly string[] = [ROLE_ADMIN, ROLE_SYSTEM];

/** The user lookups the identity API needs (structurally satisfied by `UserStore`). */
export interface IdentityUserLookup {
  /** Looks up a user by username. */
  getUserByUsername(username: string): UserRecord | undefined;
  /** Looks up a user by id. */
  getUserById(id: string): UserRecord | undefined;
  /** Lists all users. */
  listUsers(): UserRecord[];
  /** Names of the roles assigned to a user. */
  getUserRoleNames(userId: string): string[];
}

/** Options of {@link createIdentityApi}. */
export interface IdentityApiOptions {
  /** The extension the API is handed to (used in logs and owner-counter keys). */
  extensionName: string;
  /** Receives one line per minted token (audit trail). */
  log: (message: string) => void;
  /** Token minter (defaults to the process-wide {@link mintIdentityToken}). */
  mint?: (userId: string, ttlMs?: number) => string | null;
}

/**
 * Creates the identity API handed to one extension.
 *
 * Only enabled, non-privileged operator accounts are usable: portal accounts,
 * the `system` account, and accounts holding the `admin` or `system` role are
 * neither listed nor minted for.
 *
 * @param users - User lookups (the core `UserStore`)
 * @param options - Extension name, audit log sink, and minter
 * @returns The {@link IdentityApi}
 */
export function createIdentityApi(users: IdentityUserLookup, options: IdentityApiOptions): IdentityApi {
  const { extensionName, log, mint = mintIdentityToken } = options;

  const isUsable = (user: UserRecord | undefined): user is UserRecord =>
    user !== undefined &&
    !user.disabled &&
    user.kind === "operator" &&
    user.username !== SYSTEM_USERNAME &&
    !users.getUserRoleNames(user.id).some((role) => PRIVILEGED_ROLES.includes(role));

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
      const token = mint(user.id, ttlMs ?? DEFAULT_TTL_MS);
      if (token) log(`Extension "${extensionName}" minted a token for user "${username}"`);
      return token;
    },

    registerOwnerCounter(kind, counter) {
      return registerTriggerOwnerCounter(
        kind,
        (userId) => {
          const user = users.getUserById(userId);
          return user ? counter(user.username) : 0;
        },
        `ext:${extensionName}:${kind}`,
      );
    },
  };
}
