/**
 * Drizzle ORM schema for the secrets vault table.
 *
 * Stores encrypted secret values with scope-based organization,
 * ACL-controlled access, and key versioning for future rotation support.
 *
 * @module
 */

import { index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

/**
 * SQLite table for encrypted secret storage.
 *
 * Each row holds a single encrypted secret identified by a composite
 * (scope, secret_key) pair. The encrypted value is stored alongside
 * its IV and key version to support decryption and future key rotation.
 */
export const secretsVault = sqliteTable(
  "secrets_vault",
  {
    /** Auto-incrementing primary key. */
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Logical grouping for the secret (e.g. "global", "ext:telegram"). */
    scope: text("scope").notNull(),
    /** The secret identifier within its scope. */
    secretKey: text("secret_key").notNull(),
    /** Base64-encoded ciphertext including the AES-GCM auth tag. */
    encryptedValue: text("encrypted_value").notNull(),
    /** Base64-encoded 12-byte initialization vector. */
    iv: text("iv").notNull(),
    /** Encryption key version for key rotation support. */
    keyVersion: integer("key_version").notNull().default(1),
    /** JSON array of consumer patterns allowed to access this secret. */
    aclConsumers: text("acl_consumers").notNull(),
    /** Optional human-readable description of the secret's purpose. */
    description: text("description"),
    /** Epoch timestamp (ms) when the secret was created. */
    createdAt: integer("created_at").notNull(),
    /** Epoch timestamp (ms) when the secret was last updated. */
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [unique("uq_vault_scope_key").on(table.scope, table.secretKey), index("idx_vault_scope").on(table.scope)],
);
