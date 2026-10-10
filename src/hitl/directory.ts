/**
 * {@link HitlDirectory} backed by the auth user store.
 *
 * @module
 */

import { ROLE_SYSTEM } from "@shared/auth";
import { SYSTEM_USERNAME } from "@src/auth/constants";
import type { UserStore } from "@src/auth/userStore";
import type { HitlDirectory } from "./hitlService";

/**
 * Creates a directory that resolves users and roles from the user store. The
 * built-in system account and role cannot be assigned tasks.
 *
 * @param store - The user store
 * @returns The directory
 */
export function createUserDirectory(store: UserStore): HitlDirectory {
  return {
    findUserIdByUsername(username) {
      if (username === SYSTEM_USERNAME) return null;
      return store.getUserByUsername(username)?.id ?? null;
    },
    roleExists(name) {
      return name !== ROLE_SYSTEM && store.getRoleByName(name) !== undefined;
    },
    describeUser(id) {
      const user = store.getUserById(id);
      return user ? { id: user.id, username: user.username, displayName: user.displayName ?? null } : null;
    },
  };
}
