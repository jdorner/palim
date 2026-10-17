/**
 * Persistence of hub sources and install records in the shared database.
 *
 * @module
 */

import { eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { HubError } from "./errors";
import { hubInstalls, hubSources } from "./schema";

/** The shared Drizzle database type handed to extensions. */
export type HubDb = BunSQLiteDatabase<Record<string, unknown>>;

/** How an install follows its ref. */
export type RefKind = "tag" | "branch" | "commit";

/** A registered source. */
export interface SourceRecord {
  /** UUID. */
  id: string;
  /** Unique display name. */
  name: string;
  /** Remote URL. */
  url: string;
  /** Configured branch (null = remote default). */
  branch: string | null;
  /** Creation time (epoch ms). */
  createdAt: number;
  /** Last change (epoch ms). */
  updatedAt: number;
  /** Last successful fetch (epoch ms). */
  lastFetchedAt: number | null;
  /** Error of the last fetch. */
  lastError: string | null;
}

/** The state an update replaced, kept while a rollback backup exists. */
export interface PreviousInstall {
  /** Ref. */
  ref: string;
  /** Ref kind. */
  refKind: RefKind;
  /** Version. */
  version: string;
  /** Commit. */
  commit: string;
  /** Content hash. */
  contentHash: string;
}

/** An extension installed by the hub. */
export interface InstallRecord {
  /** Folder / package name. */
  name: string;
  /** Source id. */
  sourceId: string;
  /** Installed ref. */
  ref: string;
  /** Ref kind. */
  refKind: RefKind;
  /** Installed package version. */
  version: string;
  /** Installed commit. */
  commit: string;
  /** Hash of the installed files. */
  contentHash: string;
  /** Install or last update (epoch ms). */
  installedAt: number;
  /** User id of the installer. */
  installedBy: string | null;
  /** State before the last update (null = no rollback available). */
  previous: PreviousInstall | null;
}

/**
 * Store for sources and install records.
 */
export class HubStore {
  /**
   * @param db - The shared database
   */
  constructor(private readonly db: HubDb) {}

  /**
   * Lists sources sorted by name.
   *
   * @returns All sources
   */
  listSources(): SourceRecord[] {
    return this.db
      .select()
      .from(hubSources)
      .all()
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Gets a source.
   *
   * @param id - Source id
   * @returns The source, or undefined
   */
  getSource(id: string): SourceRecord | undefined {
    return this.db.select().from(hubSources).where(eq(hubSources.id, id)).get();
  }

  /**
   * Gets a source or fails.
   *
   * @param id - Source id
   * @returns The source
   * @throws {HubError} 404 when unknown
   */
  requireSource(id: string): SourceRecord {
    const source = this.getSource(id);
    if (!source) throw new HubError(404, `Source "${id}" not found`);
    return source;
  }

  /**
   * Creates a source.
   *
   * @param input - Name, URL, branch
   * @returns The new source
   * @throws {HubError} 409 when the name is taken
   */
  createSource(input: { name: string; url: string; branch: string | null }): SourceRecord {
    this.assertNameFree(input.name);
    const now = Date.now();
    const record: SourceRecord = {
      id: crypto.randomUUID(),
      name: input.name,
      url: input.url,
      branch: input.branch,
      createdAt: now,
      updatedAt: now,
      lastFetchedAt: null,
      lastError: null,
    };
    this.db.insert(hubSources).values(record).run();
    return record;
  }

  /**
   * Updates a source's name, URL, or branch.
   *
   * @param id - Source id
   * @param patch - Changed fields
   * @returns The updated source
   * @throws {HubError} 404 unknown, 409 name taken
   */
  updateSource(id: string, patch: { name?: string; url?: string; branch?: string | null }): SourceRecord {
    const current = this.requireSource(id);
    if (patch.name !== undefined && patch.name !== current.name) this.assertNameFree(patch.name);
    const next: SourceRecord = { ...current, ...patch, updatedAt: Date.now() };
    this.db
      .update(hubSources)
      .set({ name: next.name, url: next.url, branch: next.branch, updatedAt: next.updatedAt })
      .where(eq(hubSources.id, id))
      .run();
    return next;
  }

  /**
   * Records the outcome of a fetch.
   *
   * @param id - Source id
   * @param error - Error message, or null on success
   */
  recordFetch(id: string, error: string | null): void {
    const set = error === null ? { lastFetchedAt: Date.now(), lastError: null } : { lastError: error };
    this.db.update(hubSources).set(set).where(eq(hubSources.id, id)).run();
  }

  /**
   * Deletes a source.
   *
   * @param id - Source id
   * @throws {HubError} 404 unknown, 409 while installs reference it
   */
  deleteSource(id: string): void {
    this.requireSource(id);
    const used = this.listInstalls().filter((i) => i.sourceId === id);
    if (used.length > 0) {
      throw new HubError(409, `Source is used by installed extensions: ${used.map((i) => i.name).join(", ")}`);
    }
    this.db.delete(hubSources).where(eq(hubSources.id, id)).run();
  }

  /**
   * Lists install records sorted by name.
   *
   * @returns All installs
   */
  listInstalls(): InstallRecord[] {
    return this.db
      .select()
      .from(hubInstalls)
      .all()
      .map(toInstall)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Gets an install record.
   *
   * @param name - Extension folder name
   * @returns The record, or undefined
   */
  getInstall(name: string): InstallRecord | undefined {
    const row = this.db.select().from(hubInstalls).where(eq(hubInstalls.name, name)).get();
    return row ? toInstall(row) : undefined;
  }

  /**
   * Inserts or replaces an install record.
   *
   * @param record - The record
   */
  saveInstall(record: InstallRecord): void {
    const row = { ...record, previous: record.previous ? JSON.stringify(record.previous) : null };
    this.db.insert(hubInstalls).values(row).onConflictDoUpdate({ target: hubInstalls.name, set: row }).run();
  }

  /**
   * Deletes an install record.
   *
   * @param name - Extension folder name
   */
  deleteInstall(name: string): void {
    this.db.delete(hubInstalls).where(eq(hubInstalls.name, name)).run();
  }

  private assertNameFree(name: string): void {
    if (this.listSources().some((s) => s.name === name)) {
      throw new HubError(409, `A source named "${name}" already exists`);
    }
  }
}

/** Maps a database row to an install record. */
function toInstall(row: typeof hubInstalls.$inferSelect): InstallRecord {
  return {
    ...row,
    refKind: row.refKind as RefKind,
    previous: row.previous ? (JSON.parse(row.previous) as PreviousInstall) : null,
  };
}
