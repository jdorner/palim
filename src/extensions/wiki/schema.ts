/**
 * Wiki extension database schema.
 *
 * Defines the `ext_wiki_embeddings` table for caching generated
 * embedding vectors keyed by content hash.
 */

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Cached wiki chunk embeddings.
 *
 * Each row stores an embedding vector for a content hash, avoiding
 * re-generation of embeddings for unchanged wiki content across restarts.
 * The `model` column ensures cache entries are invalidated when the
 * embedding model changes.
 */
export const wikiEmbeddings = sqliteTable("ext_wiki_embeddings", {
  /** SHA-256 hash of the chunk text (title + content). */
  contentHash: text("content_hash").primaryKey(),
  /** JSON-encoded float array (the embedding vector). */
  embedding: text("embedding").notNull(),
  /** Model ID used to generate this embedding. */
  model: text("model").notNull(),
  /** Vector dimension (length of the embedding array). */
  dimension: integer("dimension").notNull(),
  /** Creation timestamp (epoch ms). */
  createdAt: integer("created_at").notNull(),
});
