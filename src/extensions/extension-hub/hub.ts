/**
 * Extension Hub service: sources, catalog, install, update, and uninstall.
 *
 * Every mutating operation runs under one in-process lock, so installs,
 * removals, and fetches never interleave.
 *
 * Updating an installed tree is sequential: the old folder is moved out and the
 * registry confirms the unload before the new folder is moved in, so the
 * directory watcher sees a plain unload followed by a load. The old tree is kept
 * until the new one has loaded, to restore it when the update fails.
 *
 * @module
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { ExternalExtensionsApi, Logger } from "@ext/types";
import {
  buildCatalog,
  type CatalogView,
  findUpdate,
  type LoadedInfo,
  latestRelease,
  type SourceSnapshot,
  scanSource,
  type UpdateInfo,
} from "./catalog";
import { HubError } from "./errors";
import { assertSafeRef, assertSafeRemoteUrl, remoteOrigin } from "./git";
import {
  assertExtensionName,
  hashTree,
  type LoadOutcome,
  moveAside,
  placeTree,
  type ResolvedTarget,
  resolveTarget,
  stageTree,
  type WaitOptions,
  waitForLoad,
  waitForUnload,
} from "./installer";
import { SourceRepo } from "./sources";
import type { HubStore, InstallRecord, SourceRecord } from "./store";

/** Default wait for a freshly placed extension to load (dependency install included). */
const DEFAULT_LOAD_WAIT: WaitOptions = { timeoutMs: 90_000, pollMs: 500 };

/** Default wait for a removed extension to unload. */
const DEFAULT_UNLOAD_WAIT: WaitOptions = { timeoutMs: 15_000, pollMs: 250 };

/** Dependencies of {@link HubService}. */
export interface HubServiceDeps {
  /** Persistence. */
  store: HubStore;
  /** Registry view (loaded extensions, load failures, external directory). */
  extensions: ExternalExtensionsApi;
  /** Hub work directory (`<DATA_DIR>/extension-hub`): mirrors, staging, trash. */
  workRoot: string;
  /** Logger. */
  log: Logger;
  /** Reads a source's HTTPS token. */
  getToken: (sourceId: string) => Promise<string | null>;
  /** Stores (or clears with null) a source's HTTPS token. */
  setToken: (sourceId: string, token: string | null) => Promise<void>;
  /** Whether prereleases count as "latest". */
  includePrereleases: () => boolean;
  /** Load wait override (tests). */
  loadWait?: WaitOptions;
  /** Unload wait override (tests). */
  unloadWait?: WaitOptions;
  /**
   * Whether the server runs under `bun --watch`/`--hot`. Bun then keeps an
   * extension's other modules cached across reloads, so updates need a restart.
   */
  watchMode?: boolean;
}

/** Warning added to updates under `bun --watch`/`--hot`. */
export const WATCH_MODE_WARNING =
  "The server runs in watch mode (bun run dev), where Bun keeps the extension's other modules cached: " +
  "restart the server to run the new version completely.";

/** Source input as accepted by the API. */
export interface SourceInput {
  /** Display name. */
  name: string;
  /** Remote URL. */
  url: string;
  /** Branch (null/empty = remote default). */
  branch?: string | null;
  /** HTTPS token (undefined = unchanged, null/empty = clear). */
  token?: string | null;
}

/** Result of creating or refreshing a source. */
export interface SourceResult {
  /** The source after the operation. */
  source: SourceRecord;
  /** Fetch error, or null. */
  error: string | null;
}

/** Install request. */
export interface InstallRequest {
  /** Source id. */
  sourceId: string;
  /** Extension name. */
  name: string;
  /** Version to install (release tag `<name>@<version>`). */
  version?: string;
  /** Tag, branch, or commit to install. */
  ref?: string;
  /** Installing user. */
  userId: string | null;
}

/** Install result. */
export interface InstallResult {
  /** The install record. */
  install: InstallRecord;
  /** Load outcome (`timeout` = still loading, check the catalog later). */
  outcome: LoadOutcome;
  /** Non-fatal findings (e.g. manifest version differs from package.json). */
  warnings: string[];
}

/** Update request. */
export interface UpdateRequest {
  /** Extension name. */
  name: string;
  /** Version to update to (default: the available update). */
  version?: string;
  /** Tag, branch, or commit to switch to. */
  ref?: string;
  /** Overwrite local modifications, or reinstall the same commit. */
  force?: boolean;
  /** Updating user. */
  userId: string | null;
}

/** Result of an update. */
export interface UpdateResult extends InstallResult {
  /** Version that was replaced. */
  from: string;
}

/** An installed extension with an available update. */
export interface UpdateSummary {
  /** Extension name. */
  name: string;
  /** Installed version. */
  installedVersion: string;
  /** Installed ref. */
  ref: string;
  /** The update. */
  update: UpdateInfo;
}

/** Result of a periodic or manual check. */
export interface CheckResult {
  /** Installs with an update. */
  updates: UpdateSummary[];
  /** Sources whose fetch failed. */
  errors: Array<{ source: string; error: string }>;
}

/**
 * The hub service.
 */
export class HubService {
  private readonly repos = new Map<string, SourceRepo>();
  private readonly snapshots = new Map<string, SourceSnapshot>();
  private lock: Promise<unknown> = Promise.resolve();

  /**
   * @param deps - Store, registry view, paths, token access, settings
   */
  constructor(private readonly deps: HubServiceDeps) {}

  /** The external extensions directory. */
  private get externalDir(): string {
    return this.deps.extensions.externalDir;
  }

  /**
   * Scans the mirrors that already exist (no network), so the catalog is
   * available right after start.
   */
  async init(): Promise<void> {
    for (const source of this.deps.store.listSources()) {
      const repo = this.repo(source);
      if (!repo.exists()) continue;
      try {
        this.snapshots.set(source.id, await scanSource(repo, source.branch));
      } catch (err) {
        this.deps.log.warn(`[extension-hub] Could not scan mirror of "${source.name}": ${(err as Error).message}`);
      }
    }
  }

  /**
   * Lists sources.
   *
   * @returns All sources
   */
  listSources(): SourceRecord[] {
    return this.deps.store.listSources();
  }

  /**
   * Registers a source and fetches it. A failing fetch keeps the source (with
   * its error) so the URL or credentials can be corrected.
   *
   * @param input - Name, URL, branch, token
   * @returns The source and the fetch error
   * @throws {HubError} 400 invalid input, 409 name taken
   */
  createSource(input: SourceInput): Promise<SourceResult> {
    return this.exclusive(async () => {
      const source = this.deps.store.createSource(normalizeSource(input));
      if (input.token) {
        try {
          await this.deps.setToken(source.id, input.token);
        } catch (err) {
          this.deps.store.deleteSource(source.id);
          throw err;
        }
      }
      return this.fetchSource(source.id);
    });
  }

  /**
   * Updates a source; a changed URL or branch triggers a fresh fetch.
   *
   * A stored token is never sent to another host: moving the URL to a
   * different scheme, host, or port requires re-entering or clearing it.
   *
   * @param id - Source id
   * @param input - Changed fields
   * @returns The source and the fetch error (null when nothing was fetched)
   * @throws {HubError} 400 invalid input or a stored token on an origin change
   */
  updateSource(id: string, input: Partial<SourceInput>): Promise<SourceResult> {
    return this.exclusive(async () => {
      const current = this.deps.store.requireSource(id);
      const patch: { name?: string; url?: string; branch?: string | null } = {};
      if (input.name !== undefined) patch.name = normalizeName(input.name);
      if (input.url !== undefined) patch.url = assertSafeRemoteUrl(input.url);
      if (input.branch !== undefined) patch.branch = normalizeBranch(input.branch);
      if (
        patch.url !== undefined &&
        input.token === undefined &&
        remoteOrigin(patch.url) !== remoteOrigin(current.url) &&
        (await this.deps.getToken(id)) !== null
      ) {
        throw new HubError(400, "The repository host changed: re-enter the access token or clear it");
      }
      const source = this.deps.store.updateSource(id, patch);
      if (input.token !== undefined) await this.deps.setToken(id, input.token || null);
      const urlChanged = source.url !== current.url;
      if (urlChanged) await this.repo(source).remove();
      if (urlChanged || source.branch !== current.branch || input.token) return this.fetchSource(id);
      return { source, error: null };
    });
  }

  /**
   * Deletes a source and its mirror.
   *
   * @param id - Source id
   * @throws {HubError} 404 unknown, 409 while installs reference it
   */
  deleteSource(id: string): Promise<void> {
    return this.exclusive(async () => {
      const source = this.deps.store.requireSource(id);
      this.deps.store.deleteSource(id);
      await this.repo(source).remove();
      this.repos.delete(id);
      this.snapshots.delete(id);
      await this.deps.setToken(id, null).catch(() => {});
    });
  }

  /**
   * Fetches a source and rescans it.
   *
   * @param id - Source id
   * @returns The source and the fetch error
   */
  refreshSource(id: string): Promise<SourceResult> {
    return this.exclusive(() => this.fetchSource(id));
  }

  /**
   * Fetches all sources.
   *
   * @returns One result per source
   */
  refreshAll(): Promise<SourceResult[]> {
    return this.exclusive(async () => {
      const results: SourceResult[] = [];
      for (const source of this.deps.store.listSources()) results.push(await this.fetchSource(source.id));
      return results;
    });
  }

  /**
   * Builds the catalog view from the current snapshots.
   *
   * @returns The catalog
   */
  async catalog(): Promise<CatalogView> {
    const loadedByFolder = new Map<string, LoadedInfo & { name: string }>();
    for (const entry of this.deps.extensions.list()) {
      if (entry.dir && path.dirname(path.resolve(entry.dir)) === path.resolve(this.externalDir)) {
        loadedByFolder.set(path.basename(entry.dir), {
          name: entry.name,
          version: entry.version,
          state: entry.state,
          enabled: entry.enabled,
          error: entry.error,
        });
      }
    }
    const installs = this.deps.store.listInstalls();
    const modified = new Set<string>();
    for (const install of installs) {
      const dir = path.join(this.externalDir, install.name);
      if (existsSync(dir) && (await hashTree(dir)) !== install.contentHash) modified.add(install.name);
    }
    return buildCatalog({
      sources: this.deps.store.listSources(),
      snapshots: this.snapshots,
      installs,
      modified,
      loadedByFolder,
      folders: await this.externalFolders(),
      includePrereleases: this.deps.includePrereleases(),
    });
  }

  /**
   * Installs an extension from a source.
   *
   * With neither `version` nor `ref`, the newest release is installed, or the
   * source branch when the extension has no release. A fresh install that
   * fails to load is removed again.
   *
   * @param request - Source, name, version or ref, user
   * @returns The record, load outcome, and warnings
   * @throws {HubError} 400 invalid, 404 unknown, 409 conflict, 422 not installable or failed to load
   */
  install(request: InstallRequest): Promise<InstallResult> {
    return this.exclusive(async () => {
      const name = assertExtensionName(request.name);
      const source = this.deps.store.requireSource(request.sourceId);
      if (this.deps.store.getInstall(name)) throw new HubError(409, `"${name}" is already installed`);
      const targetDir = path.join(this.externalDir, name);
      if (existsSync(targetDir)) {
        throw new HubError(409, `A local extension folder "${name}" exists; the hub does not overwrite it`);
      }
      if (this.deps.extensions.list().some((e) => e.name === name)) {
        throw new HubError(409, `An extension named "${name}" is already loaded`);
      }

      const repo = this.repo(source);
      if (!repo.exists()) {
        const { error } = await this.fetchSource(source.id);
        if (error) throw new HubError(502, error);
      }
      const target = await resolveTarget(repo, name, request, this.defaultTarget(source.id, name));
      const staged = await stageTree(repo, name, target, path.join(this.deps.workRoot, "staging"), {
        sourceId: source.id,
        url: source.url,
      });

      const since = Date.now();
      try {
        await placeTree(staged.dir, targetDir);
        this.deps.extensions.sync(name);
      } catch (err) {
        await rm(staged.dir, { recursive: true, force: true });
        throw err;
      }
      const install: InstallRecord = {
        name,
        sourceId: source.id,
        ref: target.ref,
        refKind: target.refKind,
        version: staged.meta.version,
        commit: target.commit,
        contentHash: staged.contentHash,
        installedAt: Date.now(),
        installedBy: request.userId,
      };
      this.deps.store.saveInstall(install);
      this.deps.log.info(
        `[extension-hub] Installed "${name}" ${install.version} (${target.ref} @ ${target.commit.slice(0, 10)})`,
      );

      const outcome = await waitForLoad(
        this.deps.extensions,
        targetDir,
        since,
        this.deps.loadWait ?? DEFAULT_LOAD_WAIT,
      );
      if (outcome.status === "failed") {
        await this.removeFolder(targetDir);
        this.deps.store.deleteInstall(name);
        throw new HubError(422, `"${name}" failed to load and was removed: ${outcome.error}`);
      }
      const warnings = versionWarnings(name, install.version, outcome);
      for (const w of warnings) this.deps.log.warn(`[extension-hub] ${w}`);
      return { install, outcome, warnings };
    });
  }

  /**
   * Uninstalls an extension the hub installed. Settings and secrets stay, so
   * a later reinstall picks them up.
   *
   * @param name - Extension name
   * @returns Whether the registry confirmed the unload
   * @throws {HubError} 404 when the hub did not install it
   */
  uninstall(name: string): Promise<{ unloaded: boolean }> {
    return this.exclusive(async () => {
      assertExtensionName(name);
      if (!this.deps.store.getInstall(name)) throw new HubError(404, `"${name}" was not installed by the hub`);
      const unloaded = await this.removeFolder(path.join(this.externalDir, name));
      await rm(this.backupDir(name), { recursive: true, force: true });
      this.deps.store.deleteInstall(name);
      this.deps.log.info(`[extension-hub] Uninstalled "${name}"`);
      return { unloaded };
    });
  }

  /**
   * Updates an installed extension, by default to its available update.
   * Refused when the installed files were changed locally (unless `force`).
   * When the new version fails to load, the previous one is restored.
   *
   * @param request - Name, optional target version or ref, force, user
   * @returns The new record, load outcome, warnings, and replaced version
   * @throws {HubError} 404 not installed, 409 modified / up to date, 422 failed to load (previous version restored)
   */
  update(request: UpdateRequest): Promise<UpdateResult> {
    return this.exclusive(async () => {
      const name = assertExtensionName(request.name);
      const current = this.requireInstall(name);
      const dir = this.installedDir(name);
      if (!request.force && (await hashTree(dir)) !== current.contentHash) {
        throw new HubError(409, `"${name}" was modified locally; force the update to discard the changes`, {
          modified: true,
        });
      }

      const source = this.deps.store.requireSource(current.sourceId);
      const repo = this.repo(source);
      const pending = findUpdate(current, this.snapshots.get(source.id) ?? null, this.deps.includePrereleases());
      const explicit = request.version !== undefined || request.ref !== undefined;
      if (!explicit && !pending) throw new HubError(409, `"${name}" is up to date`);
      const fallback = pending ? { ref: pending.ref, refKind: current.refKind, commit: pending.commit } : null;
      const target = await resolveTarget(repo, name, request, fallback);
      if (target.commit === current.commit && target.ref === current.ref && !request.force) {
        throw new HubError(409, `"${name}" is already at ${target.ref}`);
      }
      const staged = await stageTree(repo, name, target, path.join(this.deps.workRoot, "staging"), {
        sourceId: source.id,
        url: source.url,
      });

      const backup = this.backupDir(name);
      const outcome = await this.swap(dir, staged.dir, backup);
      if (outcome.status === "failed") {
        const failed = await this.trashSlot(name);
        await this.swap(dir, backup, failed);
        await rm(path.dirname(failed), { recursive: true, force: true });
        throw new HubError(
          422,
          `"${name}" ${target.ref} failed to load (${outcome.error}); restored ${current.version}`,
        );
      }

      const install: InstallRecord = {
        name,
        sourceId: source.id,
        ref: target.ref,
        refKind: target.refKind,
        version: staged.meta.version,
        commit: target.commit,
        contentHash: staged.contentHash,
        installedAt: Date.now(),
        installedBy: request.userId,
      };
      this.deps.store.saveInstall(install);
      // Loaded: the old tree is no longer needed.
      await rm(backup, { recursive: true, force: true });
      this.deps.log.info(`[extension-hub] Updated "${name}" ${current.version} -> ${install.version} (${target.ref})`);
      const warnings = this.updateWarnings(name, install.version, outcome);
      for (const w of warnings) this.deps.log.warn(`[extension-hub] ${w}`);
      return { install, outcome, warnings, from: current.version };
    });
  }

  /**
   * Lists installs with an available update, from the last fetched state.
   *
   * @returns Updates sorted by name
   */
  updates(): UpdateSummary[] {
    const result: UpdateSummary[] = [];
    for (const install of this.deps.store.listInstalls()) {
      const update = findUpdate(install, this.snapshots.get(install.sourceId) ?? null, this.deps.includePrereleases());
      if (update) result.push({ name: install.name, installedVersion: install.version, ref: install.ref, update });
    }
    return result;
  }

  /**
   * Fetches all sources and reports available updates and fetch errors.
   *
   * @returns Updates and errors
   */
  async check(): Promise<CheckResult> {
    const results = await this.refreshAll();
    return {
      updates: this.updates(),
      errors: results.filter((r) => r.error).map((r) => ({ source: r.source.name, error: r.error! })),
    };
  }

  /** Runs a function under the hub lock. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => {});
    return run;
  }

  /** Returns (and caches) the mirror of a source. */
  private repo(source: SourceRecord): SourceRepo {
    let repo = this.repos.get(source.id);
    if (!repo) {
      repo = new SourceRepo(path.join(this.deps.workRoot, "repos", `${source.id}.git`), source.url, () =>
        this.deps.getToken(source.id),
      );
      this.repos.set(source.id, repo);
    }
    repo.setUrl(source.url);
    return repo;
  }

  /** Fetches and rescans a source (caller holds the lock); errors are recorded, not thrown. */
  private async fetchSource(id: string): Promise<SourceResult> {
    const source = this.deps.store.requireSource(id);
    const repo = this.repo(source);
    let error: string | null = null;
    try {
      await repo.sync();
      this.snapshots.set(id, await scanSource(repo, source.branch));
    } catch (err) {
      error = (err as Error).message;
      this.deps.log.warn(`[extension-hub] Fetching "${source.name}" failed: ${error}`);
    }
    this.deps.store.recordFetch(id, error);
    return { source: this.deps.store.requireSource(id), error };
  }

  /** Default install target: newest release, else the source branch head. */
  private defaultTarget(sourceId: string, name: string): ResolvedTarget | null {
    const ext = this.snapshots.get(sourceId)?.extensions.find((e) => e.name === name);
    if (!ext) return null;
    const latest = latestRelease(ext.releases, this.deps.includePrereleases());
    if (latest) return { ref: latest.tag, refKind: "tag", commit: latest.commit };
    if (ext.head?.installable) return { ref: ext.head.branch, refKind: "branch", commit: ext.head.commit };
    return null;
  }

  /** Warnings after an update replaced a loaded extension. */
  private updateWarnings(name: string, version: string, outcome: LoadOutcome): string[] {
    if (this.deps.watchMode) return [WATCH_MODE_WARNING];
    return versionWarnings(name, version, outcome);
  }

  /** Returns the install record or fails with 404. */
  private requireInstall(name: string): InstallRecord {
    const install = this.deps.store.getInstall(name);
    if (!install) throw new HubError(404, `"${name}" was not installed by the hub`);
    return install;
  }

  /** Returns the folder of an install, failing when it disappeared. */
  private installedDir(name: string): string {
    const dir = path.join(this.externalDir, name);
    if (!existsSync(dir)) {
      throw new HubError(409, `"${name}" is missing from the extensions directory; uninstall and reinstall it`);
    }
    return dir;
  }

  /** Where an update parks the old tree until the new one has loaded. */
  private backupDir(name: string): string {
    return path.join(this.deps.workRoot, "backup", name);
  }

  /** Returns a fresh, not yet existing path below the trash directory. */
  private async trashSlot(name: string): Promise<string> {
    const trash = path.join(this.deps.workRoot, "trash");
    await mkdir(trash, { recursive: true });
    return path.join(await mkdtemp(path.join(trash, `${name}-`)), name);
  }

  /**
   * Replaces the extension in `dir` with the tree at `incoming`, moving the
   * old tree to `outgoing` (replaced if it exists). Waits for the registry to
   * unload the old and load the new extension.
   */
  private async swap(dir: string, incoming: string, outgoing: string): Promise<LoadOutcome> {
    await rm(outgoing, { recursive: true, force: true });
    await mkdir(path.dirname(outgoing), { recursive: true });
    const folder = path.basename(dir);
    await rename(dir, outgoing);
    this.deps.extensions.sync(folder);
    await waitForUnload(this.deps.extensions, dir, this.deps.unloadWait ?? DEFAULT_UNLOAD_WAIT);
    const since = Date.now();
    await rename(incoming, dir);
    this.deps.extensions.sync(folder);
    return waitForLoad(this.deps.extensions, dir, since, this.deps.loadWait ?? DEFAULT_LOAD_WAIT);
  }

  /** Moves an extension folder out (the watcher unloads it), waits, then deletes it. */
  private async removeFolder(dir: string): Promise<boolean> {
    if (!existsSync(dir)) return true;
    const moved = await moveAside(dir, path.join(this.deps.workRoot, "trash"));
    this.deps.extensions.sync(path.basename(dir));
    const unloaded = await waitForUnload(this.deps.extensions, dir, this.deps.unloadWait ?? DEFAULT_UNLOAD_WAIT);
    await rm(path.dirname(moved), { recursive: true, force: true });
    return unloaded;
  }

  /** Folder names in the external directory that contain an `index.ts`. */
  private async externalFolders(): Promise<string[]> {
    if (!existsSync(this.externalDir)) return [];
    const folders: string[] = [];
    for await (const match of new Bun.Glob("*/index.ts").scan({ cwd: this.externalDir, onlyFiles: true })) {
      folders.push(match.split("/")[0]!);
    }
    return folders;
  }
}

/** Validates and normalizes a source input. */
function normalizeSource(input: SourceInput): { name: string; url: string; branch: string | null } {
  return {
    name: normalizeName(input.name),
    url: assertSafeRemoteUrl(input.url),
    branch: normalizeBranch(input.branch ?? null),
  };
}

/** Validates a source display name. */
function normalizeName(name: string): string {
  const value = name.trim();
  if (!value || value.length > 100) throw new HubError(400, "Source name must be 1-100 characters");
  return value;
}

/** Validates a branch name (empty = remote default). */
function normalizeBranch(branch: string | null): string | null {
  const value = branch?.trim();
  return value ? assertSafeRef(value) : null;
}

/**
 * Compares the loaded manifest version with the installed package version.
 *
 * @param name - Extension name
 * @param packageVersion - package.json version
 * @param outcome - Load outcome
 * @returns Warnings (empty when consistent or not yet loaded)
 */
export function versionWarnings(name: string, packageVersion: string, outcome: LoadOutcome): string[] {
  if (outcome.status !== "loaded" || outcome.version === packageVersion) return [];
  return [
    `"${name}": manifest version ${outcome.version} differs from package.json version ${packageVersion}; ` +
      `use version: pkg.version in the manifest`,
  ];
}
