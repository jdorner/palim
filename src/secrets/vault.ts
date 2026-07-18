/**
 * Encrypted secret vault backed by SQLite.
 *
 * Provides AES-256-GCM encryption/decryption via Web Crypto API
 * and orchestrates secret storage, ACL enforcement, and audit logging.
 *
 * @module
 */

import { and, eq, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import createLogger from "logging";
import { matchesPattern } from "./acl";
import { SecretAuditLogger, secretAuditLog } from "./audit";
import type { SecretAuditRecord, SecretResolution } from "./types";
import { secretsVault } from "./vaultSchema";

const logger = createLogger("Secrets:Vault");

/**
 * AES-256-GCM encryption service using the Web Crypto API.
 *
 * Handles encrypting plaintext secret values and decrypting stored ciphertext.
 * Each encryption operation uses a unique random 12-byte IV. The ciphertext
 * output includes the 16-byte authentication tag appended by Web Crypto.
 */
export class EncryptionService {
  private key: CryptoKey;

  private constructor(key: CryptoKey) {
    this.key = key;
  }

  /**
   * Create a new EncryptionService instance by importing a master key.
   *
   * @param masterKeyBytes - The raw master key bytes (must be >= 32 bytes)
   * @returns A configured EncryptionService ready for encrypt/decrypt operations
   * @throws Error if the master key is shorter than 32 bytes
   */
  static async create(masterKeyBytes: Buffer): Promise<EncryptionService> {
    if (masterKeyBytes.length < 32) {
      throw new Error(`Master key must be at least 32 bytes (256 bits), got ${masterKeyBytes.length} bytes`);
    }

    const keyData = masterKeyBytes.subarray(0, 32);
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(keyData),
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );

    return new EncryptionService(cryptoKey);
  }

  /**
   * Encrypt a plaintext string using AES-256-GCM with a random IV.
   *
   * @param plaintext - The string value to encrypt
   * @returns Object containing base64-encoded IV and encrypted value (ciphertext + auth tag)
   */
  async encrypt(plaintext: string): Promise<{ iv: string; encryptedValue: string }> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);

    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, this.key, encoded);

    return {
      iv: Buffer.from(iv).toString("base64"),
      encryptedValue: Buffer.from(ciphertext).toString("base64"),
    };
  }

  /**
   * Decrypt an encrypted value using AES-256-GCM.
   *
   * @param iv - Base64-encoded 12-byte initialization vector
   * @param encryptedValue - Base64-encoded ciphertext (includes auth tag)
   * @returns The decrypted plaintext string, or null if decryption fails (e.g. auth tag mismatch)
   */
  async decrypt(iv: string, encryptedValue: string): Promise<string | null> {
    try {
      const ivBytes = Buffer.from(iv, "base64");
      const ciphertext = Buffer.from(encryptedValue, "base64");

      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(ivBytes) },
        this.key,
        new Uint8Array(ciphertext),
      );

      return new TextDecoder().decode(decrypted);
    } catch (_) {
      logger.error("Decryption failed for key");
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// SecretVault types
// ---------------------------------------------------------------------------

/**
 * Configuration for creating a SecretVault instance.
 */
export interface SecretVaultConfig {
  /** The shared Drizzle database instance. */
  database: BunSQLiteDatabase;
  /** 32-byte AES master key (decoded from env or derived from .env.keys). */
  masterKey: Buffer;
}

/**
 * Schema entry describing a secret an extension requires.
 */
export interface SecretSchemaEntry {
  /** Secret key name (e.g. "API_KEY"). */
  key: string;
  /** Human-readable description of the secret's purpose. */
  description: string;
  /** Whether the secret is required for the extension to function. */
  required: boolean;
  /** Optional grouping label for related secrets. */
  group?: string;
}

/**
 * Status of a single secret relative to the extension's declared schema.
 */
export interface SecretStatus {
  /** Secret key name. */
  key: string;
  /** Human-readable description from the schema. */
  description: string;
  /** Whether the secret is required. */
  required: boolean;
  /** Optional grouping label. */
  group?: string;
  /** Whether a value is currently stored in the vault. */
  status: "set" | "unset";
}

// ---------------------------------------------------------------------------
// SecretVault class
// ---------------------------------------------------------------------------

/**
 * SQLite-backed encrypted secret vault with ACL enforcement and audit logging.
 *
 * Orchestrates encryption/decryption, per-row access control, and audit trail
 * for extension secrets stored in the `secrets_vault` table.
 */
export class SecretVault {
  private encryption: EncryptionService;
  private audit: SecretAuditLogger;
  private db: BunSQLiteDatabase;

  private constructor(encryption: EncryptionService, audit: SecretAuditLogger, db: BunSQLiteDatabase) {
    this.encryption = encryption;
    this.audit = audit;
    this.db = db;
  }

  /**
   * Create a new SecretVault instance.
   *
   * Initializes the encryption service from the provided master key and sets up
   * the audit logger backed by the same database.
   *
   * @param config - Vault configuration with database and master key
   * @returns A configured SecretVault ready for operations
   * @throws Error if the master key is shorter than 32 bytes
   */
  static async create(config: SecretVaultConfig): Promise<SecretVault> {
    const encryption = await EncryptionService.create(config.masterKey);
    const audit = new SecretAuditLogger(config.database);
    return new SecretVault(encryption, audit, config.database);
  }

  /**
   * Resolve a secret with ACL enforcement and audit logging.
   *
   * Looks up the secret by (scope, key), checks whether the consumer is allowed
   * access via the stored ACL patterns, decrypts if granted, and logs the attempt.
   *
   * @param scope - The logical scope (e.g. extension name)
   * @param key - The secret key within the scope
   * @param consumer - The consumer identity requesting access (e.g. "ext:telegram")
   * @returns Resolution result with value (if granted) and access metadata
   */
  async resolve(scope: string, key: string, consumer: string): Promise<SecretResolution> {
    const secretName = `${scope}/${key}`;

    const row = this.db
      .select()
      .from(secretsVault)
      .where(and(eq(secretsVault.scope, scope), eq(secretsVault.secretKey, key)))
      .get();

    // Key not found - return null with granted (not an ACL denial)
    if (!row) {
      this.audit.log({
        secretName,
        consumer,
        action: "read",
        result: "granted",
      });
      return { value: null, granted: true };
    }

    // ACL check
    const aclConsumers: string[] = JSON.parse(row.aclConsumers);
    const allowed = aclConsumers.some((pattern) => matchesPattern(consumer, pattern));

    if (!allowed) {
      this.audit.log({
        secretName,
        consumer,
        action: "read",
        result: "denied",
        reason: "ACL denied",
      });
      return { value: null, granted: false, reason: "ACL denied" };
    }

    // Decrypt
    const value = await this.encryption.decrypt(row.iv, row.encryptedValue);

    if (value === null) {
      this.audit.log({
        secretName,
        consumer,
        action: "read",
        result: "denied",
        reason: "Decryption failed",
      });
      return { value: null, granted: false, reason: "Decryption failed" };
    }

    this.audit.log({
      secretName,
      consumer,
      action: "read",
      result: "granted",
    });

    return { value, granted: true };
  }

  /**
   * Store (encrypt) multiple secret values atomically with ACL.
   *
   * Uses a database transaction to ensure all keys succeed or none are persisted.
   * By default includes `ext:{scope}` in the ACL consumers (owner pattern invariant).
   * Pass `options.skipOwnerPattern` to suppress this for non-extension scopes (e.g. "global").
   *
   * @param scope - The logical scope (e.g. extension name or "global")
   * @param entries - Key-value pairs to store (key -> plaintext value)
   * @param consumers - Optional additional consumer patterns for ACL access
   * @param options - Optional behavior modifiers
   */
  async bulkUpsert(
    scope: string,
    entries: Record<string, string>,
    consumers?: string[],
    options?: { skipOwnerPattern?: boolean },
  ): Promise<void> {
    const aclPatterns: string[] = consumers ? [...consumers] : [];
    if (!options?.skipOwnerPattern) {
      const ownerPattern = `ext:${scope}`;
      if (!aclPatterns.includes(ownerPattern)) {
        aclPatterns.unshift(ownerPattern);
      }
    }
    const aclJson = JSON.stringify([...new Set(aclPatterns)]);
    const now = Date.now();

    // Pre-encrypt all values before entering the transaction
    const encrypted = await Promise.all(
      Object.entries(entries).map(async ([key, value]) => {
        const { iv, encryptedValue } = await this.encryption.encrypt(value);
        return { key, iv, encryptedValue };
      }),
    );

    this.db.transaction((tx) => {
      for (const { key, iv, encryptedValue } of encrypted) {
        tx.insert(secretsVault)
          .values({
            scope,
            secretKey: key,
            encryptedValue,
            iv,
            keyVersion: 1,
            aclConsumers: aclJson,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [secretsVault.scope, secretsVault.secretKey],
            set: {
              encryptedValue,
              iv,
              keyVersion: 1,
              aclConsumers: aclJson,
              updatedAt: now,
            },
          })
          .run();

        this.audit.log({
          secretName: `${scope}/${key}`,
          consumer: "admin:web",
          action: "write",
          result: "granted",
        });
      }
    });
  }

  /**
   * Remove a single secret from the vault.
   *
   * @param scope - The logical scope (e.g. extension name)
   * @param key - The secret key to remove
   * @param consumer - The consumer identity performing the deletion (for audit)
   * @returns True if the secret was deleted, false if it was not found
   */
  async remove(scope: string, key: string, consumer: string): Promise<boolean> {
    const secretName = `${scope}/${key}`;

    // Check existence before delete (drizzle .run() returns void)
    const exists = await this.has(scope, key);
    if (!exists) {
      return false;
    }

    this.db
      .delete(secretsVault)
      .where(and(eq(secretsVault.scope, scope), eq(secretsVault.secretKey, key)))
      .run();

    this.audit.log({
      secretName,
      consumer,
      action: "delete",
      result: "granted",
    });

    return true;
  }

  /**
   * Check whether a secret exists in the vault (without decryption).
   *
   * @param scope - The logical scope (e.g. extension name)
   * @param key - The secret key to check
   * @returns True if the secret exists
   */
  async has(scope: string, key: string): Promise<boolean> {
    const row = this.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(secretsVault)
      .where(and(eq(secretsVault.scope, scope), eq(secretsVault.secretKey, key)))
      .get();

    return (row?.count ?? 0) > 0;
  }

  /**
   * List secrets for a scope with set/unset status relative to a schema.
   *
   * Checks which keys from the provided schema exist in the database and
   * returns the status for each entry without decrypting values.
   *
   * @param scope - The logical scope (e.g. extension name)
   * @param schema - The extension's declared secret schema entries
   * @returns Array of status objects for each schema entry
   */
  listStatus(scope: string, schema: SecretSchemaEntry[]): SecretStatus[] {
    const existingRows = this.db
      .select({ secretKey: secretsVault.secretKey })
      .from(secretsVault)
      .where(eq(secretsVault.scope, scope))
      .all();

    const existingKeys = new Set(existingRows.map((r) => r.secretKey));

    return schema.map((entry) => ({
      key: entry.key,
      description: entry.description,
      required: entry.required,
      group: entry.group,
      status: existingKeys.has(entry.key) ? ("set" as const) : ("unset" as const),
    }));
  }

  /**
   * Resolve a secret by key across all scopes, with ACL enforcement and audit logging.
   *
   * Searches all scopes for a matching key and returns the first row where the
   * consumer identity passes the ACL check. Used by workflow templates that need
   * to access secrets stored under any extension's scope.
   *
   * Security: On denial, the audit log uses the generic `*​/{key}` pattern rather than
   * revealing the actual scope(s) where the key exists, preventing scope enumeration
   * by unauthorized consumers.
   *
   * @param key - The secret key to search for
   * @param consumer - The consumer identity requesting access (e.g. "workflow:my-wf")
   * @returns Resolution result with value (if granted), origin scope, and access metadata
   */
  async resolveByKey(key: string, consumer: string): Promise<SecretResolution> {
    const rows = this.db.select().from(secretsVault).where(eq(secretsVault.secretKey, key)).all();

    // Key not found in any scope
    if (rows.length === 0) {
      this.audit.log({
        secretName: `*/${key}`,
        consumer,
        action: "read",
        result: "granted",
      });
      return { value: null, granted: true };
    }

    // Find the first row where ACL grants access
    for (const row of rows) {
      const aclConsumers: string[] = JSON.parse(row.aclConsumers);
      const allowed = aclConsumers.some((pattern) => matchesPattern(consumer, pattern));

      if (allowed) {
        const value = await this.encryption.decrypt(row.iv, row.encryptedValue);
        const secretName = `${row.scope}/${key}`;

        if (value === null) {
          this.audit.log({
            secretName,
            consumer,
            action: "read",
            result: "denied",
            reason: "Decryption failed",
          });
          return { value: null, granted: false, reason: "Decryption failed", scope: row.scope };
        }

        // Log the cross-scope access with the resolved scope for auditing
        this.audit.log({
          secretName,
          consumer,
          action: "read",
          result: "granted",
        });
        return { value, granted: true, scope: row.scope };
      }
    }

    // No row granted access — use generic pattern to avoid leaking scope names
    this.audit.log({
      secretName: `*/${key}`,
      consumer,
      action: "read",
      result: "denied",
      reason: "ACL denied",
    });
    return { value: null, granted: false, reason: "ACL denied" };
  }

  /**
   * Get audit log entries filtered by scope.
   *
   * Returns recent audit records whose secretName starts with the given scope
   * prefix (i.e. "{scope}/").
   *
   * @param scope - The logical scope to filter by
   * @param limit - Maximum number of entries to return (default: 50)
   * @returns Array of audit records, most recent first
   */
  getAuditLog(scope: string, limit = 50): SecretAuditRecord[] {
    const prefix = `${scope}/`;

    return this.db
      .select()
      .from(secretAuditLog)
      .where(sql`${secretAuditLog.secretName} LIKE ${`${prefix}%`}`)
      .orderBy(sql`${secretAuditLog.timestamp} DESC`)
      .limit(limit)
      .all() as SecretAuditRecord[];
  }

  // -------------------------------------------------------------------------
  // Global scope helpers
  // -------------------------------------------------------------------------

  /** The reserved scope name for non-extension secrets. */
  static readonly GLOBAL_SCOPE = "global";

  /**
   * List all secrets stored under the global scope.
   *
   * Returns key, description, and ACL consumers for each row without
   * decrypting any values.
   *
   * @returns Array of global secret metadata entries
   */
  listGlobal(): GlobalSecretEntry[] {
    const rows = this.db
      .select({
        secretKey: secretsVault.secretKey,
        description: secretsVault.description,
        aclConsumers: secretsVault.aclConsumers,
        updatedAt: secretsVault.updatedAt,
      })
      .from(secretsVault)
      .where(eq(secretsVault.scope, SecretVault.GLOBAL_SCOPE))
      .all();

    return rows.map((row) => ({
      key: row.secretKey,
      description: row.description ?? undefined,
      consumers: JSON.parse(row.aclConsumers) as string[],
      updatedAt: row.updatedAt,
    }));
  }

  /**
   * Upsert global secrets with explicit ACL consumers and optional descriptions.
   *
   * Unlike extension `bulkUpsert`, this does NOT inject an `ext:{scope}` owner
   * pattern since global secrets have no owning extension.
   *
   * @param entries - Key-value pairs to store (key -> plaintext value)
   * @param consumers - Consumer patterns allowed to access these secrets (e.g. ["workflow:*"])
   * @param descriptions - Optional per-key descriptions for documentation
   */
  async upsertGlobal(
    entries: Record<string, string>,
    consumers: string[],
    descriptions?: Record<string, string>,
  ): Promise<void> {
    const scope = SecretVault.GLOBAL_SCOPE;
    const aclJson = JSON.stringify([...new Set(consumers)]);
    const now = Date.now();

    const encrypted = await Promise.all(
      Object.entries(entries).map(async ([key, value]) => {
        const { iv, encryptedValue } = await this.encryption.encrypt(value);
        return { key, iv, encryptedValue };
      }),
    );

    this.db.transaction((tx) => {
      for (const { key, iv, encryptedValue } of encrypted) {
        tx.insert(secretsVault)
          .values({
            scope,
            secretKey: key,
            encryptedValue,
            iv,
            keyVersion: 1,
            aclConsumers: aclJson,
            description: descriptions?.[key] ?? null,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [secretsVault.scope, secretsVault.secretKey],
            set: {
              encryptedValue,
              iv,
              keyVersion: 1,
              aclConsumers: aclJson,
              description: descriptions?.[key] ?? null,
              updatedAt: now,
            },
          })
          .run();

        this.audit.log({
          secretName: `${scope}/${key}`,
          consumer: "admin:web",
          action: "write",
          result: "granted",
        });
      }
    });
  }

  /**
   * Remove a global secret by key.
   *
   * @param key - The secret key to remove
   * @returns True if the secret was deleted, false if not found
   */
  async removeGlobal(key: string): Promise<boolean> {
    return this.remove(SecretVault.GLOBAL_SCOPE, key, "admin:web");
  }

  /**
   * Update the ACL consumers and/or description of a global secret
   * without re-encrypting the value.
   *
   * @param key - The secret key to update
   * @param consumers - New consumer patterns (replaces existing)
   * @param description - Optional new description (null to clear)
   * @returns True if the secret was found and updated, false if not found
   */
  updateGlobalMeta(key: string, consumers: string[], description?: string | null): boolean {
    const scope = SecretVault.GLOBAL_SCOPE;
    const exists = this.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(secretsVault)
      .where(and(eq(secretsVault.scope, scope), eq(secretsVault.secretKey, key)))
      .get();

    if (!exists || exists.count === 0) return false;

    const aclJson = JSON.stringify([...new Set(consumers)]);
    const now = Date.now();

    this.db
      .update(secretsVault)
      .set({
        aclConsumers: aclJson,
        ...(description !== undefined ? { description: description ?? null } : {}),
        updatedAt: now,
      })
      .where(and(eq(secretsVault.scope, scope), eq(secretsVault.secretKey, key)))
      .run();

    this.audit.log({
      secretName: `${scope}/${key}`,
      consumer: "admin:web",
      action: "write",
      result: "granted",
      reason: "acl_updated",
    });

    return true;
  }
}

// ---------------------------------------------------------------------------
// Global secret entry type
// ---------------------------------------------------------------------------

/**
 * Metadata for a single global secret (no plaintext value exposed).
 */
export interface GlobalSecretEntry {
  /** The secret key name. */
  key: string;
  /** Optional human-readable description. */
  description?: string;
  /** Consumer patterns allowed to access this secret. */
  consumers: string[];
  /** Epoch timestamp (ms) of last update. */
  updatedAt: number;
}
