/**
 * First-boot seeding for the auth/RBAC subsystem.
 *
 * Ensures the built-in roles (`admin`, `user`, `system`) exist, seeds an admin
 * account from configuration when the users table is empty, and assigns any
 * pre-migration ownerless resources (chat sessions, trigger registrations) to
 * the seeded admin so nothing is left orphaned by the transition away from the
 * shared `AUTH_TOKEN`.
 *
 * Seeding is idempotent: on subsequent boots with an existing admin it makes no
 * changes beyond ensuring built-in roles are present.
 *
 * @module
 */

import { randomBytes } from "node:crypto";
import { BUILT_IN_ROLES, ROLE_ADMIN, ROLE_SYSTEM } from "@shared/auth";
import { sessions } from "@src/db/schema";
import { fileWatchers } from "@src/extensions/core/filewatcher/schema";
import { webhooks } from "@src/extensions/core/webhooks/schema";
import { isNull } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { AuthService } from "./authService";
import { SYSTEM_USERNAME } from "./constants";
import type { UserStore } from "./userStore";

/** Outcome of a seeding run, for logging by the caller. */
export interface SeedResult {
  /** Whether an admin account was created on this run. */
  createdAdmin: boolean;
  /** The admin user's id (existing or newly created). */
  adminUserId: string;
  /** The built-in system user's id (ensured on every run). */
  systemUserId: string;
  /**
   * The generated one-time admin password, present only when an admin was
   * created without an explicitly configured password. The caller logs it once.
   */
  generatedPassword?: string;
  /** Number of ownerless sessions assigned to the admin on this run. */
  claimedSessions: number;
  /** Number of ownerless trigger registrations assigned to the admin on this run. */
  claimedTriggers: number;
}

/** Options for {@link seedAuth}. */
export interface SeedAuthOptions {
  /** The user store to seed into. */
  userStore: UserStore;
  /** The auth service (used to hash the admin password). */
  authService: AuthService;
  /** The shared database (used for bulk legacy-owner assignment). */
  db: BunSQLiteDatabase<Record<string, unknown>>;
  /** Configured admin username. */
  adminUsername: string;
  /** Configured admin password; when empty, a one-time password is generated. */
  adminPassword: string;
}

/**
 * Ensures the built-in roles exist, returning their ids by name.
 *
 * @param userStore - The user store.
 * @returns A map of built-in role name to its role id.
 */
function ensureBuiltInRoles(userStore: UserStore): Map<string, string> {
  const ids = new Map<string, string>();
  for (const def of Object.values(BUILT_IN_ROLES)) {
    const existing = userStore.getRoleByName(def.name);
    const role = existing ?? userStore.createRole(def.name, def.description, true);
    // Keep the description and permission set in sync with the catalog.
    if (existing && existing.description !== def.description) {
      userStore.setRoleDescription(role.id, def.description);
    }
    if (def.permissions !== null) {
      userStore.setRolePermissions(role.id, def.permissions);
    }
    ids.set(def.name, role.id);
  }
  return ids;
}

/**
 * Assigns all ownerless chat sessions and trigger registrations to a user.
 *
 * @param db - The shared database.
 * @param userId - The user id to claim the ownerless rows for.
 * @returns Counts of sessions and triggers claimed.
 */
function claimOwnerlessResources(
  db: BunSQLiteDatabase<Record<string, unknown>>,
  userId: string,
): { claimedSessions: number; claimedTriggers: number } {
  const orphanSessions = db.select({ id: sessions.id }).from(sessions).where(isNull(sessions.userId)).all();
  if (orphanSessions.length > 0) {
    db.update(sessions).set({ userId }).where(isNull(sessions.userId)).run();
  }

  const orphanWatchers = db
    .select({ slug: fileWatchers.slug })
    .from(fileWatchers)
    .where(isNull(fileWatchers.createdByUserId))
    .all();
  if (orphanWatchers.length > 0) {
    db.update(fileWatchers).set({ createdByUserId: userId }).where(isNull(fileWatchers.createdByUserId)).run();
  }

  const orphanWebhooks = db
    .select({ slug: webhooks.slug })
    .from(webhooks)
    .where(isNull(webhooks.createdByUserId))
    .all();
  if (orphanWebhooks.length > 0) {
    db.update(webhooks).set({ createdByUserId: userId }).where(isNull(webhooks.createdByUserId)).run();
  }

  return {
    claimedSessions: orphanSessions.length,
    claimedTriggers: orphanWatchers.length + orphanWebhooks.length,
  };
}

/**
 * Generates a strong, URL-safe one-time password.
 *
 * @returns A random 24-character-ish base64url string.
 */
function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}

/**
 * Ensures the built-in non-login `system` user exists and holds the `system`
 * role, returning its id.
 *
 * The account has an empty password hash (which never verifies), so it cannot
 * log in; it exists only so a system-principal internal token can be minted.
 *
 * @param userStore - The user store.
 * @param systemRoleId - The id of the `system` role.
 * @returns The system user's id.
 */
function ensureSystemUser(userStore: UserStore, systemRoleId: string | undefined): string {
  const existing = userStore.getUserByUsername(SYSTEM_USERNAME);
  if (existing) return existing.id;
  const user = userStore.createUser({ username: SYSTEM_USERNAME, passwordHash: "", provider: "system" });
  if (systemRoleId) {
    userStore.setUserRoles(user.id, [systemRoleId]);
  }
  return user.id;
}

/**
 * Seeds the auth subsystem on boot.
 *
 * Behavior:
 * - Always ensures the built-in roles exist and their permissions match the catalog.
 * - When the users table is empty, creates the admin account (generating a
 *   one-time password if none is configured), assigns it the `admin` role, and
 *   claims all ownerless sessions/triggers for it.
 * - When users already exist, makes no account changes and claims nothing
 *   (ownership has already been established).
 *
 * @param opts - Seeding dependencies and admin configuration.
 * @returns A {@link SeedResult} describing what was created/claimed.
 * @throws When an underlying store or database write fails.
 */
export async function seedAuth(opts: SeedAuthOptions): Promise<SeedResult> {
  const { userStore, authService, db, adminUsername, adminPassword } = opts;

  const roleIds = ensureBuiltInRoles(userStore);

  // Decide admin seeding based on whether any real (non-system) user exists,
  // captured BEFORE ensuring the system user (which would make the table non-empty).
  const humanUsersExist = userStore.listUsers().some((u) => u.username !== SYSTEM_USERNAME);

  // The system user is ensured on every boot (idempotent), independent of admin seeding.
  const systemUserId = ensureSystemUser(userStore, roleIds.get(ROLE_SYSTEM));

  if (humanUsersExist) {
    const existingAdmin = userStore
      .listUsers()
      .find((u) => u.username !== SYSTEM_USERNAME && userStore.getUserRoleNames(u.id).includes(ROLE_ADMIN));
    return {
      createdAdmin: false,
      adminUserId: existingAdmin?.id ?? "",
      systemUserId,
      claimedSessions: 0,
      claimedTriggers: 0,
    };
  }

  const generated = adminPassword ? undefined : generatePassword();
  const password = adminPassword || (generated as string);
  const passwordHash = await authService.hashPassword(password);
  const admin = userStore.createUser({ username: adminUsername, passwordHash });

  const adminRoleId = roleIds.get(ROLE_ADMIN);
  if (adminRoleId) {
    userStore.setUserRoles(admin.id, [adminRoleId]);
  }

  const { claimedSessions, claimedTriggers } = claimOwnerlessResources(db, admin.id);

  return {
    createdAdmin: true,
    adminUserId: admin.id,
    systemUserId,
    generatedPassword: generated,
    claimedSessions,
    claimedTriggers,
  };
}
