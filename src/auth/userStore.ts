/**
 * SQLite-backed store for users, roles, role-permission mappings, user-role
 * assignments, and opaque login session tokens.
 *
 * Mirrors the construction pattern of {@link import("@src/variables").VariableStore}:
 * a plain class wrapping the shared Drizzle database. Reads go directly to
 * SQLite (no in-memory cache) so state is durable the moment a write commits.
 *
 * Password hashes and token hashes are stored and returned only where the
 * caller explicitly needs them (login verification, token resolution); the
 * public listing methods never expose the password hash.
 *
 * @module
 */

import type { Permission } from "@shared/auth";
import { eq, inArray, lt } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { nanoid } from "nanoid";
import { rolePermissions, roles, userRoles, userSessions, users } from "./schema";

/** A user record without the password hash, safe to expose to callers. */
export interface UserRecord {
  /** Opaque user id. */
  id: string;
  /** Unique login username. */
  username: string;
  /** Optional display name. */
  displayName?: string;
  /** Preferred UI locale; undefined follows the browser language. */
  locale?: string;
  /** Identity provider ("local" for password accounts). */
  provider: string;
  /** Whether the account is disabled. */
  disabled: boolean;
  /** Epoch timestamp (ms) when created. */
  createdAt: number;
  /** Epoch timestamp (ms) of last modification. */
  updatedAt: number;
}

/** A user record including the password hash (for login verification only). */
export interface UserWithSecret extends UserRecord {
  /** argon2id password hash. */
  passwordHash: string;
}

/** A role record. */
export interface RoleRecord {
  /** Opaque role id. */
  id: string;
  /** Unique role name. */
  name: string;
  /** Optional description. */
  description?: string;
  /** Whether this is a built-in role that cannot be deleted. */
  builtIn: boolean;
  /** Epoch timestamp (ms) when created. */
  createdAt: number;
  /** Epoch timestamp (ms) of last modification. */
  updatedAt: number;
}

/** A persisted opaque session token row. */
export interface SessionTokenRecord {
  /** Opaque session id. */
  id: string;
  /** Owning user id. */
  userId: string;
  /** SHA-256 hash of the bearer token. */
  tokenHash: string;
  /** Epoch timestamp (ms) when created. */
  createdAt: number;
  /** Epoch timestamp (ms) when the token expires. */
  expiresAt: number;
  /** Epoch timestamp (ms) of last use. */
  lastUsedAt: number;
}

/** Options for creating a user. */
export interface CreateUserOptions {
  /** Unique login username. */
  username: string;
  /** argon2id password hash (already hashed by the caller). */
  passwordHash: string;
  /** Optional display name. */
  displayName?: string;
  /** Optional preferred UI locale. */
  locale?: string;
  /** Identity provider; defaults to "local". */
  provider?: string;
  /** Optional explicit id (defaults to a generated nanoid). */
  id?: string;
}

/**
 * SQLite-backed store for the auth/RBAC domain.
 *
 * Constructed once during boot from the shared database and injected wherever
 * user/role/session lookups are needed. All methods are synchronous (Bun SQLite
 * is synchronous) and throw on underlying SQLite failures.
 */
export class UserStore {
  private db: BunSQLiteDatabase<Record<string, unknown>>;

  /**
   * Create a new UserStore backed by the shared Drizzle database.
   *
   * @param db - The shared Drizzle database instance (from getDb()).
   */
  constructor(db: BunSQLiteDatabase<Record<string, unknown>>) {
    this.db = db;
  }

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  /**
   * Insert a new user.
   *
   * @param opts - The user's username, password hash, and optional fields.
   * @returns The created user record (without the password hash).
   * @throws When the username already exists (unique constraint) or the write fails.
   */
  createUser(opts: CreateUserOptions): UserRecord {
    const now = Date.now();
    const id = opts.id ?? nanoid();
    this.db
      .insert(users)
      .values({
        id,
        username: opts.username,
        passwordHash: opts.passwordHash,
        displayName: opts.displayName ?? null,
        locale: opts.locale ?? null,
        provider: opts.provider ?? "local",
        disabled: false,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return {
      id,
      username: opts.username,
      displayName: opts.displayName,
      locale: opts.locale,
      provider: opts.provider ?? "local",
      disabled: false,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Count the total number of users.
   *
   * Used at boot to decide whether to seed the admin account.
   *
   * @returns The number of user rows.
   * @throws When the read fails.
   */
  countUsers(): number {
    return this.db.select({ id: users.id }).from(users).all().length;
  }

  /**
   * Look up a user by username, including the password hash for verification.
   *
   * @param username - The login username.
   * @returns The user with its password hash, or undefined when not found.
   * @throws When the read fails.
   */
  getUserByUsername(username: string): UserWithSecret | undefined {
    const row = this.db.select().from(users).where(eq(users.username, username)).get();
    return row ? this.toUserWithSecret(row) : undefined;
  }

  /**
   * Look up a user by id.
   *
   * @param id - The user id.
   * @returns The user record (without password hash), or undefined when not found.
   * @throws When the read fails.
   */
  getUserById(id: string): UserRecord | undefined {
    const row = this.db.select().from(users).where(eq(users.id, id)).get();
    return row ? this.toUserRecord(row) : undefined;
  }

  /**
   * List all users (without password hashes), ordered by creation time.
   *
   * @returns Every user record.
   * @throws When the read fails.
   */
  listUsers(): UserRecord[] {
    return this.db
      .select()
      .from(users)
      .all()
      .map((row) => this.toUserRecord(row));
  }

  /**
   * Enable or disable a user account.
   *
   * @param id - The user id.
   * @param disabled - Whether the account should be disabled.
   * @throws When the write fails.
   */
  setUserDisabled(id: string, disabled: boolean): void {
    this.db.update(users).set({ disabled, updatedAt: Date.now() }).where(eq(users.id, id)).run();
  }

  /**
   * Replace a user's stored password hash.
   *
   * @param id - The user id.
   * @param passwordHash - The new argon2id password hash.
   * @throws When the write fails.
   */
  setPasswordHash(id: string, passwordHash: string): void {
    this.db.update(users).set({ passwordHash, updatedAt: Date.now() }).where(eq(users.id, id)).run();
  }

  /**
   * Delete a user together with their role assignments and login sessions, in
   * a single transaction.
   *
   * Callers are expected to check {@link import("./guards").checkUserDelete}
   * first and to clean up data owned by the user in other stores.
   *
   * @param id - The user id.
   * @throws When the write fails.
   */
  deleteUser(id: string): void {
    this.db.transaction((tx) => {
      tx.delete(userRoles).where(eq(userRoles.userId, id)).run();
      tx.delete(userSessions).where(eq(userSessions.userId, id)).run();
      tx.delete(users).where(eq(users.id, id)).run();
    });
  }

  /**
   * Set or clear a user's display name.
   *
   * @param id - The user id.
   * @param displayName - The new display name, or null to clear it.
   * @throws When the write fails.
   */
  setDisplayName(id: string, displayName: string | null): void {
    this.db.update(users).set({ displayName, updatedAt: Date.now() }).where(eq(users.id, id)).run();
  }

  /**
   * Set or clear a user's preferred UI locale.
   *
   * @param id - The user id.
   * @param locale - The locale (validated by the caller), or null to follow the browser language.
   * @throws When the write fails.
   */
  setLocale(id: string, locale: string | null): void {
    this.db.update(users).set({ locale, updatedAt: Date.now() }).where(eq(users.id, id)).run();
  }

  // -------------------------------------------------------------------------
  // Roles
  // -------------------------------------------------------------------------

  /**
   * Insert a new role.
   *
   * @param name - The unique role name.
   * @param description - Optional description.
   * @param builtIn - Whether this is a built-in role; defaults to false.
   * @param id - Optional explicit id (defaults to a generated nanoid).
   * @returns The created role record.
   * @throws When the role name already exists or the write fails.
   */
  createRole(name: string, description?: string, builtIn = false, id?: string): RoleRecord {
    const now = Date.now();
    const roleId = id ?? nanoid();
    this.db
      .insert(roles)
      .values({ id: roleId, name, description: description ?? null, builtIn, createdAt: now, updatedAt: now })
      .run();
    return { id: roleId, name, description, builtIn, createdAt: now, updatedAt: now };
  }

  /**
   * Look up a role by name.
   *
   * @param name - The role name.
   * @returns The role record, or undefined when not found.
   * @throws When the read fails.
   */
  getRoleByName(name: string): RoleRecord | undefined {
    const row = this.db.select().from(roles).where(eq(roles.name, name)).get();
    return row ? this.toRoleRecord(row) : undefined;
  }

  /**
   * List all roles.
   *
   * @returns Every role record.
   * @throws When the read fails.
   */
  listRoles(): RoleRecord[] {
    return this.db
      .select()
      .from(roles)
      .all()
      .map((row) => this.toRoleRecord(row));
  }

  /**
   * Look up a role by id.
   *
   * @param id - The role id.
   * @returns The role record, or undefined when not found.
   * @throws When the read fails.
   */
  getRoleById(id: string): RoleRecord | undefined {
    const row = this.db.select().from(roles).where(eq(roles.id, id)).get();
    return row ? this.toRoleRecord(row) : undefined;
  }

  /**
   * Set or clear a role's description.
   *
   * @param id - The role id.
   * @param description - The new description, or null to clear it.
   * @throws When the write fails.
   */
  setRoleDescription(id: string, description: string | null): void {
    this.db.update(roles).set({ description, updatedAt: Date.now() }).where(eq(roles.id, id)).run();
  }

  /**
   * Delete a role together with its permission grants and user assignments,
   * in a single transaction.
   *
   * Callers are expected to check {@link import("./guards").checkRoleDelete} first.
   *
   * @param id - The role id.
   * @throws When the write fails.
   */
  deleteRole(id: string): void {
    this.db.transaction((tx) => {
      tx.delete(rolePermissions).where(eq(rolePermissions.roleId, id)).run();
      tx.delete(userRoles).where(eq(userRoles.roleId, id)).run();
      tx.delete(roles).where(eq(roles.id, id)).run();
    });
  }

  /**
   * Count how many existing users hold each role. Assignment rows whose user
   * no longer exists are ignored.
   *
   * @returns Map of role id to assigned-user count (roles with no users are absent).
   * @throws When the read fails.
   */
  countUsersByRole(): Map<string, number> {
    const counts = new Map<string, number>();
    const rows = this.db
      .select({ roleId: userRoles.roleId })
      .from(userRoles)
      .innerJoin(users, eq(userRoles.userId, users.id))
      .all();
    for (const row of rows) {
      counts.set(row.roleId, (counts.get(row.roleId) ?? 0) + 1);
    }
    return counts;
  }

  /**
   * Replace the full permission set granted by a role.
   *
   * Existing permissions for the role are deleted and replaced with the given
   * set in a single transaction.
   *
   * @param roleId - The role id.
   * @param permissions - The permission strings to grant.
   * @throws When the write fails.
   */
  setRolePermissions(roleId: string, permissions: readonly Permission[]): void {
    this.db.transaction((tx) => {
      tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId)).run();
      if (permissions.length > 0) {
        tx.insert(rolePermissions)
          .values(permissions.map((permission) => ({ roleId, permission })))
          .run();
      }
    });
  }

  /**
   * List the permission strings granted by a role.
   *
   * @param roleId - The role id.
   * @returns The role's permission strings.
   * @throws When the read fails.
   */
  getRolePermissions(roleId: string): Permission[] {
    return this.db
      .select({ permission: rolePermissions.permission })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, roleId))
      .all()
      .map((r) => r.permission as Permission);
  }

  // -------------------------------------------------------------------------
  // User-role assignments
  // -------------------------------------------------------------------------

  /**
   * Replace the full set of roles assigned to a user.
   *
   * @param userId - The user id.
   * @param roleIds - The role ids to assign.
   * @throws When the write fails.
   */
  setUserRoles(userId: string, roleIds: readonly string[]): void {
    this.db.transaction((tx) => {
      tx.delete(userRoles).where(eq(userRoles.userId, userId)).run();
      if (roleIds.length > 0) {
        tx.insert(userRoles)
          .values(roleIds.map((roleId) => ({ userId, roleId })))
          .run();
      }
    });
  }

  /**
   * List the names of roles assigned to a user.
   *
   * @param userId - The user id.
   * @returns The assigned role names.
   * @throws When the read fails.
   */
  getUserRoleNames(userId: string): string[] {
    return this.db
      .select({ name: roles.name })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(eq(userRoles.userId, userId))
      .all()
      .map((r) => r.name);
  }

  /**
   * Compute the effective (deduplicated) permission set for a user by unioning
   * the permissions of all assigned roles.
   *
   * Note: the built-in `admin` role is treated as a superuser in the ability
   * layer, so callers should check for admin membership separately rather than
   * relying on this set to enumerate every permission.
   *
   * @param userId - The user id.
   * @returns The user's effective permission strings (deduplicated).
   * @throws When the read fails.
   */
  getEffectivePermissions(userId: string): Permission[] {
    const rows = this.db
      .select({ permission: rolePermissions.permission })
      .from(userRoles)
      .innerJoin(rolePermissions, eq(userRoles.roleId, rolePermissions.roleId))
      .where(eq(userRoles.userId, userId))
      .all();
    const seen = new Set<Permission>();
    for (const row of rows) {
      seen.add(row.permission as Permission);
    }
    return [...seen];
  }

  // -------------------------------------------------------------------------
  // Session tokens
  // -------------------------------------------------------------------------

  /**
   * Insert a new opaque session-token row.
   *
   * @param opts - The user id, token hash, and expiry timestamp.
   * @returns The created session-token record.
   * @throws When the token hash collides (unique constraint) or the write fails.
   */
  insertSession(opts: { userId: string; tokenHash: string; expiresAt: number; id?: string }): SessionTokenRecord {
    const now = Date.now();
    const id = opts.id ?? nanoid();
    this.db
      .insert(userSessions)
      .values({
        id,
        userId: opts.userId,
        tokenHash: opts.tokenHash,
        createdAt: now,
        expiresAt: opts.expiresAt,
        lastUsedAt: now,
      })
      .run();
    return {
      id,
      userId: opts.userId,
      tokenHash: opts.tokenHash,
      createdAt: now,
      expiresAt: opts.expiresAt,
      lastUsedAt: now,
    };
  }

  /**
   * Find a session-token row by its token hash.
   *
   * @param tokenHash - The SHA-256 hash of the bearer token.
   * @returns The session-token record, or undefined when not found.
   * @throws When the read fails.
   */
  findSessionByTokenHash(tokenHash: string): SessionTokenRecord | undefined {
    const row = this.db.select().from(userSessions).where(eq(userSessions.tokenHash, tokenHash)).get();
    return row
      ? {
          id: row.id,
          userId: row.userId,
          tokenHash: row.tokenHash,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
          lastUsedAt: row.lastUsedAt,
        }
      : undefined;
  }

  /**
   * Update a session's last-used timestamp.
   *
   * @param id - The session id.
   * @param lastUsedAt - The new last-used epoch timestamp (ms).
   * @throws When the write fails.
   */
  touchSession(id: string, lastUsedAt: number): void {
    this.db.update(userSessions).set({ lastUsedAt }).where(eq(userSessions.id, id)).run();
  }

  /**
   * Delete a session token by its hash (logout).
   *
   * @param tokenHash - The SHA-256 hash of the bearer token.
   * @returns True when a row was deleted.
   * @throws When the write fails.
   */
  deleteSessionByTokenHash(tokenHash: string): boolean {
    const existing = this.findSessionByTokenHash(tokenHash);
    if (!existing) return false;
    this.db.delete(userSessions).where(eq(userSessions.tokenHash, tokenHash)).run();
    return true;
  }

  /**
   * Delete all session tokens belonging to a user (e.g. on disable).
   *
   * @param userId - The user id.
   * @throws When the write fails.
   */
  deleteSessionsForUser(userId: string): void {
    this.db.delete(userSessions).where(eq(userSessions.userId, userId)).run();
  }

  /**
   * Delete expired session tokens.
   *
   * @param now - The current epoch timestamp (ms); rows with expiresAt < now are removed.
   * @returns The number of rows deleted.
   * @throws When the write fails.
   */
  deleteExpiredSessions(now: number = Date.now()): number {
    const expired = this.db
      .select({ id: userSessions.id })
      .from(userSessions)
      .where(lt(userSessions.expiresAt, now))
      .all();
    if (expired.length === 0) return 0;
    this.db
      .delete(userSessions)
      .where(
        inArray(
          userSessions.id,
          expired.map((r) => r.id),
        ),
      )
      .run();
    return expired.length;
  }

  // -------------------------------------------------------------------------
  // Row mappers
  // -------------------------------------------------------------------------

  /** Maps a raw users row to a {@link UserRecord} (no password hash). */
  private toUserRecord(row: typeof users.$inferSelect): UserRecord {
    return {
      id: row.id,
      username: row.username,
      displayName: row.displayName ?? undefined,
      locale: row.locale ?? undefined,
      provider: row.provider,
      disabled: row.disabled,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** Maps a raw users row to a {@link UserWithSecret} (includes password hash). */
  private toUserWithSecret(row: typeof users.$inferSelect): UserWithSecret {
    return { ...this.toUserRecord(row), passwordHash: row.passwordHash };
  }

  /** Maps a raw roles row to a {@link RoleRecord}. */
  private toRoleRecord(row: typeof roles.$inferSelect): RoleRecord {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      builtIn: row.builtIn,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
