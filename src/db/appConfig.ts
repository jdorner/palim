/**
 * Key/value store backed by the `app_config` table.
 *
 * Provides simple `get()` and `set()` helpers so callers don't need
 * to know about Drizzle queries or the table schema.
 *
 * @module
 */

import { eq } from "drizzle-orm";
import { getDb } from "./index";
import { appConfig } from "./schema";

/**
 * Read a single configuration value by key.
 *
 * @param key - The configuration key (e.g. `"selected_model"`)
 * @returns The stored string value, or `undefined` if the key does not exist
 */
export function get(key: string): string | undefined {
  const db = getDb();
  const row = db.select().from(appConfig).where(eq(appConfig.key, key)).get();
  return row?.value;
}

/**
 * Write a configuration value, inserting or updating as needed.
 *
 * @param key - The configuration key
 * @param value - The string value to store
 */
export function set(key: string, value: string): void {
  const db = getDb();
  const now = Date.now();
  db.insert(appConfig)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({
      target: appConfig.key,
      set: { value, updatedAt: now },
    })
    .run();
}

/**
 * Remove a configuration value by key.
 *
 * @param key - The configuration key to remove
 */
export function remove(key: string): void {
  const db = getDb();
  db.delete(appConfig).where(eq(appConfig.key, key)).run();
}
