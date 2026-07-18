/**
 * File watcher registration persistence - backed by Drizzle ORM + SQLite.
 *
 * The database instance is injected via {@link initStore} during extension
 * initialization, decoupling this module from the core DB layer.
 */

import { eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { fileWatchers } from "./schema";
import type { FileWatcherEventType, FileWatcherRegistration } from "./types";

/** Module-level DB reference - set by {@link initStore}. */
let db: BunSQLiteDatabase<Record<string, unknown>>;

/**
 * Initializes the store with a database instance.
 * Must be called before any other store function.
 *
 * @param database - The shared Drizzle database instance
 */
export function initStore(database: BunSQLiteDatabase<Record<string, unknown>>): void {
  db = database;
}

/**
 * Converts a database row to a {@link FileWatcherRegistration}.
 *
 * @param row - Raw row from the file_watchers table
 * @returns The deserialized registration
 */
function rowToRegistration(row: typeof fileWatchers.$inferSelect): FileWatcherRegistration {
  let events: FileWatcherEventType[];
  try {
    const parsed = row.events ? JSON.parse(row.events) : undefined;
    events = Array.isArray(parsed) ? (parsed as FileWatcherEventType[]) : ["new"];
  } catch {
    events = ["new"];
  }

  return {
    slug: row.slug,
    name: row.name,
    path: row.path,
    patterns: JSON.parse(row.patterns) as string[],
    events,
    recursive: row.recursive,
    processExisting: row.processExisting,
    enabled: row.enabled,
    createdAt: row.createdAt,
  };
}

/**
 * Loads all file watcher registrations from the database.
 *
 * @returns Array of all registrations
 */
export function loadAll(): FileWatcherRegistration[] {
  const rows = db.select().from(fileWatchers).all();
  return rows.map(rowToRegistration);
}

/**
 * Finds a file watcher registration by slug.
 *
 * @param slug - The watcher slug to look up
 * @returns The registration, or undefined if not found
 */
export function findWatcher(slug: string): FileWatcherRegistration | undefined {
  const row = db.select().from(fileWatchers).where(eq(fileWatchers.slug, slug)).get();
  return row ? rowToRegistration(row) : undefined;
}

/**
 * Inserts a new file watcher registration.
 *
 * @param reg - The registration to insert
 */
export function insertWatcher(reg: FileWatcherRegistration): void {
  db.insert(fileWatchers)
    .values({
      slug: reg.slug,
      name: reg.name,
      path: reg.path,
      patterns: JSON.stringify(reg.patterns),
      events: JSON.stringify(reg.events),
      recursive: reg.recursive,
      processExisting: reg.processExisting,
      enabled: reg.enabled,
      createdAt: reg.createdAt,
    })
    .run();
}

/**
 * Updates an existing file watcher registration by slug.
 *
 * @param slug - The slug of the watcher to update
 * @param updates - Partial fields to update
 * @returns The updated registration, or undefined if not found
 */
export function updateWatcher(
  slug: string,
  updates: Partial<Omit<FileWatcherRegistration, "slug" | "createdAt">>,
): FileWatcherRegistration | undefined {
  const existing = findWatcher(slug);
  if (!existing) return undefined;

  const merged = { ...existing, ...updates };

  db.update(fileWatchers)
    .set({
      name: merged.name,
      path: merged.path,
      patterns: JSON.stringify(merged.patterns),
      events: JSON.stringify(merged.events),
      recursive: merged.recursive,
      processExisting: merged.processExisting,
      enabled: merged.enabled,
    })
    .where(eq(fileWatchers.slug, slug))
    .run();

  return merged;
}

/**
 * Deletes a file watcher registration by slug.
 *
 * @param slug - The slug of the watcher to delete
 * @returns True if a row was deleted
 */
export function deleteWatcher(slug: string): boolean {
  if (!findWatcher(slug)) return false;
  db.delete(fileWatchers).where(eq(fileWatchers.slug, slug)).run();
  return true;
}
