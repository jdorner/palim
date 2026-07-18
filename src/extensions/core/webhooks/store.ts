/**
 * Webhook registration persistence - backed by Drizzle ORM + SQLite.
 *
 * The database instance is injected via {@link initStore} during extension
 * initialization, decoupling this module from the core DB layer.
 */

import { eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { webhooks } from "./schema";
import type { WebhookAuthType, WebhookRegistration } from "./types";

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
 * Converts a database row to a {@link WebhookRegistration}.
 *
 * @param row - Raw row from the webhooks table
 * @returns The deserialized registration
 */
function rowToRegistration(row: typeof webhooks.$inferSelect): WebhookRegistration {
  return {
    slug: row.slug,
    name: row.name,
    authType: row.authType as WebhookAuthType,
    secret: row.secret,
    headerName: row.headerName,
    enabled: row.enabled,
    createdAt: row.createdAt,
  };
}

/**
 * Loads all webhook registrations from the database.
 *
 * @returns Array of all registrations
 */
export function loadAll(): WebhookRegistration[] {
  const rows = db.select().from(webhooks).all();
  return rows.map(rowToRegistration);
}

/**
 * Finds a webhook registration by slug.
 *
 * @param slug - The webhook slug to look up
 * @returns The registration, or undefined if not found
 */
export function findWebhook(slug: string): WebhookRegistration | undefined {
  const row = db.select().from(webhooks).where(eq(webhooks.slug, slug)).get();
  return row ? rowToRegistration(row) : undefined;
}

/**
 * Inserts a new webhook registration.
 *
 * @param reg - The registration to insert
 */
export function insertWebhook(reg: WebhookRegistration): void {
  db.insert(webhooks)
    .values({
      slug: reg.slug,
      name: reg.name,
      authType: reg.authType,
      secret: reg.secret,
      headerName: reg.headerName,
      enabled: reg.enabled,
      createdAt: reg.createdAt,
    })
    .run();
}

/**
 * Updates an existing webhook registration by slug.
 *
 * @param slug - The slug of the webhook to update
 * @param updates - Partial fields to update
 * @returns The updated registration, or undefined if not found
 */
export function updateWebhookRecord(
  slug: string,
  updates: Partial<Omit<WebhookRegistration, "slug" | "createdAt">>,
): WebhookRegistration | undefined {
  const existing = findWebhook(slug);
  if (!existing) return undefined;

  const merged = { ...existing, ...updates };

  db.update(webhooks)
    .set({
      name: merged.name,
      authType: merged.authType,
      secret: merged.secret,
      headerName: merged.headerName,
      enabled: merged.enabled,
    })
    .where(eq(webhooks.slug, slug))
    .run();

  return merged;
}

/**
 * Deletes a webhook registration by slug.
 *
 * @param slug - The slug of the webhook to delete
 * @returns True if a row was deleted
 */
export function deleteWebhook(slug: string): boolean {
  if (!findWebhook(slug)) return false;
  db.delete(webhooks).where(eq(webhooks.slug, slug)).run();
  return true;
}
