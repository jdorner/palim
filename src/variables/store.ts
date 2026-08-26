/**
 * SQLite-backed store for plaintext global variables.
 *
 * Mirrors the global helpers of the secret vault (list/upsert/remove) but
 * deliberately without encryption, per-row ACL, value masking, or read audit
 * logging. Values are stored and returned in plaintext; every workflow may read
 * every variable. Reads go directly to SQLite (no in-memory cache) so state is
 * durable the moment a write commits and every restart sees the last committed
 * state.
 *
 * @module
 */

import { eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { GlobalVariableEntry } from "./types";
import { globalVariables } from "./variablesSchema";

/**
 * Minimal interface for variable resolution within workflow templates.
 *
 * Decouples the workflows extension from the concrete {@link VariableStore}.
 * Unlike the secret resolver, there is no consumer/ACL argument because
 * variables are non-sensitive.
 */
export interface TemplateVariableResolver {
  /**
   * Resolve a variable value for template substitution.
   *
   * @param key - The variable key.
   * @returns The plaintext value, or null when the key does not exist.
   */
  resolve(key: string): string | null;

  /**
   * Report whether a variable exists (used by the load-time validator).
   *
   * @param key - The variable key.
   * @returns True when the key exists.
   */
  has(key: string): boolean;
}

/**
 * SQLite-backed store for plaintext global variables.
 *
 * Unlike the secret vault, values are stored and returned in plaintext with no
 * encryption, no per-row ACL, and no read audit logging. Every workflow may
 * read every variable. Implements {@link TemplateVariableResolver}.
 */
export class VariableStore implements TemplateVariableResolver {
  private db: BunSQLiteDatabase<any>;

  /**
   * Create a new VariableStore backed by the shared Drizzle database.
   *
   * @param db - The shared Drizzle database instance (from getDb()).
   */
  constructor(db: BunSQLiteDatabase<any>) {
    this.db = db;
  }

  /**
   * List all global variables with their plaintext values.
   *
   * @returns Every stored variable (empty array when none exist).
   * @throws When the underlying SQLite read fails.
   */
  list(): GlobalVariableEntry[] {
    const rows = this.db
      .select({
        variableKey: globalVariables.variableKey,
        value: globalVariables.value,
        description: globalVariables.description,
        updatedAt: globalVariables.updatedAt,
      })
      .from(globalVariables)
      .all();

    return rows.map((row) => ({
      key: row.variableKey,
      value: row.value,
      description: row.description ?? undefined,
      updatedAt: row.updatedAt,
    }));
  }

  /**
   * Look up a single variable by key.
   *
   * @param key - The variable key.
   * @returns The entry, or undefined when the key does not exist.
   * @throws When the underlying SQLite read fails.
   */
  get(key: string): GlobalVariableEntry | undefined {
    const row = this.db
      .select({
        variableKey: globalVariables.variableKey,
        value: globalVariables.value,
        description: globalVariables.description,
        updatedAt: globalVariables.updatedAt,
      })
      .from(globalVariables)
      .where(eq(globalVariables.variableKey, key))
      .get();

    if (!row) {
      return undefined;
    }

    return {
      key: row.variableKey,
      value: row.value,
      description: row.description ?? undefined,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Report whether a variable exists (no value read).
   *
   * @param key - The variable key.
   * @returns True when the key exists.
   * @throws When the underlying SQLite read fails.
   */
  has(key: string): boolean {
    const row = this.db
      .select({ variableKey: globalVariables.variableKey })
      .from(globalVariables)
      .where(eq(globalVariables.variableKey, key))
      .get();

    return row !== undefined;
  }

  /**
   * Insert or overwrite a variable value and description.
   *
   * Uses Drizzle onConflictDoUpdate on the unique `variableKey` column so an
   * existing key is overwritten in a single code path. On insert, createdAt and
   * updatedAt are set to the current epoch-ms; on overwrite, only updatedAt is
   * refreshed while createdAt is preserved.
   *
   * @param key - The variable key (assumed already format-validated by the caller).
   * @param value - The plaintext value.
   * @param description - Optional description; null/undefined clears it.
   * @throws When the underlying SQLite write fails.
   */
  upsert(key: string, value: string, description?: string | null): void {
    const now = Date.now();

    this.db
      .insert(globalVariables)
      .values({
        variableKey: key,
        value,
        description: description ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: globalVariables.variableKey,
        set: {
          value,
          description: description ?? null,
          updatedAt: now,
        },
      })
      .run();
  }

  /**
   * Remove a variable by key.
   *
   * @param key - The variable key.
   * @returns True when a row was deleted, false when the key did not exist.
   * @throws When the underlying SQLite write fails.
   */
  remove(key: string): boolean {
    if (!this.has(key)) {
      return false;
    }

    this.db.delete(globalVariables).where(eq(globalVariables.variableKey, key)).run();

    return true;
  }

  /**
   * Resolve a variable value for template substitution.
   *
   * Thin wrapper over {@link VariableStore.get} returning just the value or null.
   *
   * @param key - The variable key.
   * @returns The plaintext value, or null when the key does not exist.
   * @throws When the underlying SQLite read fails.
   */
  resolve(key: string): string | null {
    return this.get(key)?.value ?? null;
  }
}
