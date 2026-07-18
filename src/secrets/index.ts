/**
 * Secrets management module.
 *
 * Provides the SecretVault (SQLite-backed AES-256-GCM encrypted storage)
 * with per-row ACL and audit logging. Boot-time env vars are loaded via
 * dotenvx.config() in main.ts and accessed through process.env.
 *
 * @module
 */

export { matchesPattern } from "./acl";
export type { SecretAclEntry, SecretAuditRecord, SecretResolution, SetSecretOptions } from "./types";
