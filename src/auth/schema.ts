/**
 * Drizzle ORM schema for user management and RBAC.
 *
 * Defines the tables backing local user accounts, roles, role-to-permission
 * mappings, user-to-role assignments, and opaque login session tokens. Values
 * follow the project conventions: opaque text ids (nanoid), epoch-ms integer
 * timestamps, and unique indexes for natural keys.
 *
 * Password hashes and session token hashes are stored hashed at rest and are
 * never returned to clients. Session tokens are opaque and DB-backed so they
 * can be expired and revoked.
 *
 * @module
 */

import { integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

/**
 * Local user accounts.
 *
 * A user authenticates with a username and password (hashed with argon2id via
 * `Bun.password`). The `provider`/`providerSubject` columns are reserved so a
 * future SSO/OIDC identity can be attached without a schema change; local
 * accounts use `provider = "local"` and a null `providerSubject`.
 */
export const users = sqliteTable(
  "users",
  {
    /** Opaque server-generated identifier (nanoid). */
    id: text("id").primaryKey(),
    /** Unique login username. */
    username: text("username").notNull(),
    /** argon2id password hash (empty for non-local/SSO accounts). */
    passwordHash: text("password_hash").notNull().default(""),
    /** Optional human-readable display name. */
    displayName: text("display_name"),
    /** Identity provider: "local" for password accounts (reserved for SSO). */
    provider: text("provider").notNull().default("local"),
    /** Provider-specific subject id for SSO accounts (null for local). */
    providerSubject: text("provider_subject"),
    /** Whether the account is disabled (cannot log in). */
    disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
    /** Epoch timestamp (ms) when the account was created. */
    createdAt: integer("created_at").notNull(),
    /** Epoch timestamp (ms) of the last modification. */
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [unique("uq_users_username").on(table.username)],
);

/**
 * Named roles.
 *
 * A role groups a set of permissions (see {@link rolePermissions}). Built-in
 * roles (`admin`, `user`, `system`) are seeded on first boot; additional roles
 * can be created by administrators.
 */
export const roles = sqliteTable(
  "roles",
  {
    /** Opaque server-generated identifier (nanoid). */
    id: text("id").primaryKey(),
    /** Unique role name (e.g. "admin", "user"). */
    name: text("name").notNull(),
    /** Human-readable description of the role's purpose. */
    description: text("description"),
    /** Whether this is a built-in role that cannot be deleted. */
    builtIn: integer("built_in", { mode: "boolean" }).notNull().default(false),
    /** Epoch timestamp (ms) when the role was created. */
    createdAt: integer("created_at").notNull(),
    /** Epoch timestamp (ms) of the last modification. */
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [unique("uq_roles_name").on(table.name)],
);

/**
 * Role-to-permission mappings.
 *
 * Each row grants a single permission string to a role. A role with no rows
 * grants no permissions; the built-in `admin` role is treated as a superuser in
 * code and is not required to enumerate every permission here.
 */
export const rolePermissions = sqliteTable(
  "role_permissions",
  {
    /** Foreign key referencing {@link roles}.id. */
    roleId: text("role_id").notNull(),
    /** A permission string from the shared catalog (e.g. "chat:write"). */
    permission: text("permission").notNull(),
  },
  (table) => [primaryKey({ columns: [table.roleId, table.permission] })],
);

/**
 * User-to-role assignments.
 *
 * Each row assigns a single role to a user. A user's effective permissions are
 * the union of the permissions of all assigned roles.
 */
export const userRoles = sqliteTable(
  "user_roles",
  {
    /** Foreign key referencing {@link users}.id. */
    userId: text("user_id").notNull(),
    /** Foreign key referencing {@link roles}.id. */
    roleId: text("role_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.roleId] })],
);

/**
 * Opaque login session tokens.
 *
 * A successful login issues a random opaque token; only its hash is stored so a
 * database leak does not expose usable tokens. Sessions carry an expiry and can
 * be revoked (deleted) individually, providing stateful logout.
 */
export const userSessions = sqliteTable(
  "user_sessions",
  {
    /** Opaque server-generated identifier (nanoid). */
    id: text("id").primaryKey(),
    /** Foreign key referencing {@link users}.id. */
    userId: text("user_id").notNull(),
    /** SHA-256 hash of the opaque bearer token (never the token itself). */
    tokenHash: text("token_hash").notNull(),
    /** Epoch timestamp (ms) when the session was created. */
    createdAt: integer("created_at").notNull(),
    /** Epoch timestamp (ms) when the session expires. */
    expiresAt: integer("expires_at").notNull(),
    /** Epoch timestamp (ms) of the last authenticated request on this token. */
    lastUsedAt: integer("last_used_at").notNull(),
  },
  (table) => [unique("uq_user_sessions_token_hash").on(table.tokenHash)],
);
