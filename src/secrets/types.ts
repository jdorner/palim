/**
 * Secrets management type definitions.
 *
 * Defines types for secret resolution, ACL entries, audit records,
 * and options used by the SecretVault.
 *
 * @module
 */

/**
 * Result of a secret resolution attempt.
 * Contains the value (if access was granted) and metadata about the access.
 */
export interface SecretResolution {
  /** The decrypted secret value, or null if access was denied or key not found. */
  value: string | null;
  /** Whether access was granted. */
  granted: boolean;
  /** Reason for denial (if applicable). */
  reason?: string;
  /** The scope from which the secret was resolved (populated by cross-scope lookups). */
  scope?: string;
}

/**
 * ACL entry for a single secret key.
 */
export interface SecretAclEntry {
  /** Human-readable description of the secret's purpose. */
  description?: string;
  /** List of consumer patterns allowed to access this secret. */
  consumers: string[];
}

/**
 * A single audit log record for a secret access attempt.
 */
export interface SecretAuditRecord {
  /** Unique record ID. */
  id: string;
  /** The secret key that was accessed (or attempted). */
  secretName: string;
  /** The consumer identity that requested access. */
  consumer: string;
  /** The intended action. */
  action: "read" | "write" | "delete";
  /** Whether access was granted or denied. */
  result: "granted" | "denied";
  /** Epoch timestamp (ms). */
  timestamp: number;
  /** Optional reason (e.g. denial reason). */
  reason?: string;
}

/**
 * Options for setting a secret.
 */
export interface SetSecretOptions {
  /** Consumer patterns to grant access to this secret. */
  consumers?: string[];
  /** Human-readable description of the secret's purpose. */
  description?: string;
}
