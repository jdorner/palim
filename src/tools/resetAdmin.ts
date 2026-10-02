/**
 * Break-glass CLI to recover administrative access.
 *
 * Re-enables the given user (creating it when missing), grants it the `admin`
 * role in addition to its existing roles, sets a freshly generated password,
 * and revokes its active sessions. The new password is printed once.
 *
 * Usage: bun run reset-admin [username]
 * Default username: AUTH_ADMIN_USER (default "admin").
 *
 * @module
 */

import "@dotenvx/dotenvx/config";
import { randomBytes } from "node:crypto";
import { ROLE_ADMIN } from "@shared/auth";
import { AuthService, UserStore } from "@src/auth";
import { SYSTEM_USERNAME } from "@src/auth/constants";
import { AUTH_ADMIN_USER } from "@src/config";
import { closeDb, getDb } from "@src/db";

/** Result of a reset, for reporting. */
export interface ResetAdminResult {
  /** Whether the account had to be created. */
  created: boolean;
  /** The newly set plaintext password (print once, never store). */
  password: string;
}

/**
 * Restores admin access for a user.
 *
 * @param store - The user store.
 * @param auth - The auth service (for password hashing).
 * @param username - The account to restore.
 * @returns Whether the user was created and the new password.
 * @throws When the username is the built-in system account, the `admin` role is missing, or a write fails.
 */
export async function resetAdmin(store: UserStore, auth: AuthService, username: string): Promise<ResetAdminResult> {
  if (username === SYSTEM_USERNAME) {
    throw new Error("The built-in system account cannot be made an admin");
  }
  const adminRole = store.getRoleByName(ROLE_ADMIN);
  if (!adminRole) {
    throw new Error(`Role "${ROLE_ADMIN}" not found - start the app once to seed built-in roles`);
  }

  const password = randomBytes(18).toString("base64url");
  const passwordHash = await auth.hashPassword(password);

  const existing = store.getUserByUsername(username);
  const user = existing ?? store.createUser({ username, passwordHash });
  if (existing) {
    store.setPasswordHash(user.id, passwordHash);
    store.setUserDisabled(user.id, false);
    store.deleteSessionsForUser(user.id);
  }

  const roleIds = new Set(
    store
      .listRoles()
      .filter((r) => store.getUserRoleNames(user.id).includes(r.name))
      .map((r) => r.id),
  );
  roleIds.add(adminRole.id);
  store.setUserRoles(user.id, [...roleIds]);

  return { created: !existing, password };
}

// Main entry point (not triggered during test imports)
if (import.meta.main && !process.env.BUN_TEST) {
  const username = process.argv[2] ?? AUTH_ADMIN_USER;
  try {
    const store = new UserStore(getDb());
    const { created, password } = await resetAdmin(store, new AuthService(store), username);
    console.log(`${created ? "Created" : "Restored"} admin user "${username}".`);
    console.log(`New password: ${password}`);
    console.log("Log in and change it now.");
  } catch (err) {
    console.error(`reset-admin failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}
