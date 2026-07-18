/**
 * Audit logging for secret access attempts.
 *
 * Stores access records in the shared SQLite database via Drizzle ORM.
 * Provides append-only logging with query support for recent entries.
 *
 * @module
 */

import { desc, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { nanoid } from "nanoid";
import type { SecretAuditRecord } from "./types";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * SQLite table for secret access audit logs.
 */
export const secretAuditLog = sqliteTable(
  "secret_audit_log",
  {
    /** Unique record ID (nanoid). */
    id: text("id").primaryKey(),
    /** The secret key that was accessed or denied. */
    secretName: text("secret_name").notNull(),
    /** The consumer identity that requested access. */
    consumer: text("consumer").notNull(),
    /** The intended action: "read", "write", or "delete". */
    action: text("action").notNull(),
    /** Whether access was granted or denied. */
    result: text("result").notNull(),
    /** Epoch timestamp (ms). */
    timestamp: integer("timestamp").notNull(),
    /** Optional reason (e.g. denial reason). */
    reason: text("reason"),
  },
  (table) => [
    index("idx_secret_audit_timestamp").on(table.timestamp),
    index("idx_secret_audit_secret").on(table.secretName),
  ],
);

// ---------------------------------------------------------------------------
// Audit logger class
// ---------------------------------------------------------------------------

/**
 * Manages audit log persistence for secret access events.
 */
export class SecretAuditLogger {
  private db: BunSQLiteDatabase;

  /**
   * @param db - The shared Drizzle database instance
   */
  constructor(db: BunSQLiteDatabase) {
    this.db = db;
  }

  /**
   * Record a secret access event.
   *
   * @param record - The audit record to persist (id and timestamp are auto-generated if missing)
   */
  log(record: Omit<SecretAuditRecord, "id" | "timestamp"> & { id?: string; timestamp?: number }): void {
    const entry: SecretAuditRecord = {
      id: record.id ?? nanoid(),
      secretName: record.secretName,
      consumer: record.consumer,
      action: record.action,
      result: record.result,
      timestamp: record.timestamp ?? Date.now(),
      reason: record.reason,
    };

    this.db.insert(secretAuditLog).values(entry).run();
  }

  /**
   * Retrieve recent audit log entries.
   *
   * @param limit - Maximum number of entries to return (default: 50)
   * @returns Array of audit records, most recent first
   */
  getRecent(limit = 50): SecretAuditRecord[] {
    return this.db
      .select()
      .from(secretAuditLog)
      .orderBy(desc(secretAuditLog.timestamp))
      .limit(limit)
      .all() as SecretAuditRecord[];
  }

  /**
   * Retrieve audit entries for a specific secret.
   *
   * @param secretName - The secret key to filter by
   * @param limit - Maximum number of entries to return (default: 20)
   * @returns Array of audit records for the given secret
   */
  getForSecret(secretName: string, limit = 20): SecretAuditRecord[] {
    return this.db
      .select()
      .from(secretAuditLog)
      .where(sql`${secretAuditLog.secretName} = ${secretName}`)
      .orderBy(desc(secretAuditLog.timestamp))
      .limit(limit)
      .all() as SecretAuditRecord[];
  }
}
