/**
 * Webhooks extension database schema.
 *
 * Defines the `ext_webhooks_registrations` table for persisting
 * webhook endpoint registrations.
 */

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Webhook registrations.
 *
 * Authenticated HTTP endpoints that external services can POST to,
 * emitting domain events for downstream consumers (e.g. workflows).
 */
export const webhooks = sqliteTable("ext_webhooks_registrations", {
  /** URL-safe slug - the endpoint becomes POST /ext/webhooks/receive/:slug. */
  slug: text("slug").primaryKey(),
  /** Human-readable label. */
  name: text("name").notNull(),
  /** Authentication strategy: "hmac-sha256", "bearer", or "none". */
  authType: text("auth_type").notNull().default("none"),
  /** HMAC secret or bearer token (depending on authType). */
  secret: text("secret").notNull().default(""),
  /** HTTP header carrying the signature/token (e.g. "X-Hub-Signature-256"). */
  headerName: text("header_name").notNull().default(""),
  /** Whether this webhook is active. */
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /** Creation timestamp (ms). */
  createdAt: integer("created_at").notNull(),
});
