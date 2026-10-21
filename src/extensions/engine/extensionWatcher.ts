/**
 * Watches EXTERNAL_EXTENSIONS_DIR for new or removed extension directories
 * and automatically loads/unloads them at runtime without restart.
 *
 * Detection logic:
 * - A directory is considered a valid extension when it contains an `index.ts` file.
 * - New directories trigger ExternalDependencyResolver + loadOne().
 * - Removed directories trigger unloadOne().
 * - Changes below an extension's `ui/` directory rebuild only its UI pages
 *   (registry.rebuildUi()), without reloading the extension.
 * - Changes below an extension's `locales/` directory reload only its
 *   translation catalogs (registry.reloadLocales()).
 * - Events only mark a folder for reconciliation; what happens is decided
 *   from the folder's state when the batch runs (see reconcile decisions), so
 *   late, duplicate, or missing events cannot unload or reload the wrong tree.
 * - Filesystem events are debounced to batch rapid changes; explicit
 *   requestSync() calls run at once.
 */

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import createLogger from "logging";
import type { ExtensionRegistry } from "./registry";

const logger = createLogger("ExtensionWatcher");

/** Default debounce interval in milliseconds. */
const DEFAULT_DEBOUNCE_MS = 1000;

/** Configuration for the extension directory watcher. */
export interface ExtensionWatcherConfig {
  /** Absolute path to the external extensions directory. */
  directory: string;
  /** The extension registry instance used for loadOne/unloadOne calls. */
  registry: ExtensionRegistry;
  /** Debounce interval in ms (defaults to 1000). */
  debounceMs?: number;
}

/** What a reconciliation does with one folder. */
type ReconcileAction = "load" | "unload" | "reload";

/**
 * Identity of a loaded extension tree: the folder's and `index.ts`'s inode
 * plus the entry point's modification time. Moving another tree into place
 * (or `rm` + `cp`) changes the inodes, editing `index.ts` its mtime.
 *
 * @param dir - Extension directory
 * @returns The fingerprint, or null when the tree is not readable
 */
function treeFingerprint(dir: string): string | null {
  try {
    const folder = statSync(dir);
    const entry = statSync(path.join(dir, "index.ts"));
    return `${folder.ino}:${entry.ino}:${entry.mtimeMs}`;
  } catch {
    return null;
  }
}

/**
 * Watches the external extensions directory for added/removed extension folders
 * and triggers hot-load or unload via the ExtensionRegistry.
 */
export class ExtensionWatcher {
  private readonly directory: string;
  private readonly registry: ExtensionRegistry;
  private readonly debounceMs: number;

  private watcher: FSWatcher | null = null;

  /** Folders to reconcile with the registry in the next run. */
  private pendingFolders = new Set<string>();
  /** Pending extension directories whose UI sources changed. */
  private pendingUiRebuilds = new Set<string>();
  /** Extensions whose `locales/` catalogs changed. */
  private pendingLocaleReloads = new Set<string>();
  /** Debounce timer handle. */
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Tail of the serialized processing runs. */
  private processing: Promise<void> = Promise.resolve();

  /** Tracks known extension directories (dirname -> true). */
  private knownExtensions = new Set<string>();

  /** Fingerprint of the tree each loaded folder was loaded from (see {@link treeFingerprint}). */
  private loadedFingerprints = new Map<string, string>();

  /**
   * Maps directory name to the manifest name used by the registry.
   * The directory name and manifest name can differ (e.g., dir "ext_c4-palim" -> manifest "c4-palim").
   */
  private dirToManifestName = new Map<string, string>();

  constructor(config: ExtensionWatcherConfig) {
    this.directory = config.directory;
    this.registry = config.registry;
    this.debounceMs = config.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /**
   * Start watching the external extensions directory.
   * Scans for existing extensions first, then watches for changes.
   */
  async start(): Promise<void> {
    if (this.watcher) return;

    // Ensure directory exists
    if (!existsSync(this.directory)) {
      logger.debug(`External extensions directory does not exist: ${this.directory}`);
      return;
    }

    // Seed known extensions from what's already loaded
    this.seedKnownExtensions();

    this.watcher = chokidar.watch(this.directory, {
      persistent: true,
      ignoreInitial: true,
      depth: 8, // <name>/index.ts for reloads, nested <name>/ui/** for UI rebuilds, <name>/locales/* for catalogs
      // Ignore node_modules, .git, and generated tsconfig files within extension
      // directories. Chokidar has no glob support; regexes see forward slashes.
      ignored: [/\/(node_modules|\.git)(\/|$)/, /\/tsconfig\.json(\.tmp)?$/],
    });

    this.watcher.on("add", (filePath) => this.handleUiChange(filePath) || this.handleEntryPoint(filePath));
    this.watcher.on("change", (filePath) => this.handleUiChange(filePath) || this.handleEntryPoint(filePath));
    this.watcher.on("addDir", (dirPath) => this.handleFolder(dirPath));
    this.watcher.on("unlinkDir", (dirPath) => this.handleUiChange(dirPath) || this.handleFolder(dirPath));
    this.watcher.on("unlink", (filePath) => this.handleUiChange(filePath) || this.handleEntryPoint(filePath));
    this.watcher.on("error", (err) => {
      logger.error("Extension watcher error:", err);
    });

    // Wait for chokidar to finish initial scan before returning
    await new Promise<void>((resolve) => {
      this.watcher!.on("ready", resolve);
    });

    logger.info(`Watching for external extensions in: ${this.directory}`);
  }

  /**
   * Reconciles one extension folder with the registry at once (without the
   * debounce): load when `<folder>/index.ts` exists and nothing is loaded from
   * it, reload when a different tree is loaded, unload when the folder is
   * gone. Moving folders back and forth quickly can produce no events at all,
   * so tools that move extension folders call this afterwards.
   *
   * @param folder - Folder name below the watched directory
   * @returns Resolves once the folder has been reconciled
   */
  requestSync(folder: string): Promise<void> {
    if (!folder || folder.includes("/") || folder.startsWith(".")) return this.processing;
    this.pendingFolders.add(folder);
    return this.enqueueRun();
  }

  /**
   * Stop watching and clean up.
   */
  async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.pendingFolders.clear();
    this.pendingUiRebuilds.clear();
    this.pendingLocaleReloads.clear();
    this.dirToManifestName.clear();
  }

  /**
   * Seeds the known extensions set from both the registry's loaded list and
   * the current filesystem state, and fingerprints the folders loaded at
   * boot so that events which change nothing are ignored.
   */
  private seedKnownExtensions(): void {
    // Add all loaded external extensions
    const infos = this.registry.getLoadedExtensionInfo();
    for (const info of infos) {
      if (info.source === "external") {
        this.knownExtensions.add(info.name);
      }
    }

    // Scan the filesystem for directories with index.ts that exist.
    // This covers extensions that failed to load (skipped, disabled, broken).
    const glob = new Bun.Glob("*/index.ts");
    try {
      for (const entry of glob.scanSync({ cwd: this.directory, onlyFiles: true })) {
        const dirName = entry.split("/")[0];
        if (dirName) {
          this.knownExtensions.add(dirName);
          const dir = path.join(this.directory, dirName);
          const name = this.registry.loadedNameForDir(dir);
          const fingerprint = treeFingerprint(dir);
          if (name && fingerprint) {
            this.loadedFingerprints.set(dirName, fingerprint);
            if (name !== dirName) this.dirToManifestName.set(dirName, name);
          }
        }
      }
    } catch {
      // Directory unreadable - continue with what we have
    }
  }

  /**
   * Handles a change below a known extension's `ui/` directory (scheduling a UI
   * rebuild) or `locales/` directory (scheduling a catalog reload).
   *
   * @param changedPath - Absolute path of the added, changed, or removed entry
   * @returns `true` when the path belongs to a `ui/` or `locales/` tree (and was handled)
   */
  private handleUiChange(changedPath: string): boolean {
    const parts = path.relative(this.directory, changedPath).split(path.sep);
    if (parts.length < 3 || (parts[1] !== "ui" && parts[1] !== "locales")) return false;
    const extName = parts[0]!;
    if (!this.knownExtensions.has(extName)) return true;

    if (parts[1] === "ui") {
      logger.debug(`Detected UI source change in ${extName}: ${parts.slice(1).join("/")}`);
      this.pendingUiRebuilds.add(extName);
    } else {
      logger.debug(`Detected catalog change in ${extName}: ${parts.slice(1).join("/")}`);
      this.pendingLocaleReloads.add(extName);
    }
    this.scheduleDebouncedProcess();
    return true;
  }

  /**
   * Handles an event for an extension entry point (`<name>/index.ts` added,
   * changed, or removed) by marking its folder for reconciliation.
   */
  private handleEntryPoint(filePath: string): void {
    const parts = path.relative(this.directory, filePath).split(path.sep);
    if (parts.length === 2 && parts[1] === "index.ts") this.queueReconcile(parts[0]!);
  }

  /**
   * Handles a direct child directory appearing or disappearing by marking it
   * for reconciliation (a folder copied as a whole may report only `addDir`).
   */
  private handleFolder(dirPath: string): void {
    const parts = path.relative(this.directory, dirPath).split(path.sep);
    if (parts.length === 1 && parts[0] && parts[0] !== "." && parts[0] !== "..") this.queueReconcile(parts[0]);
  }

  /** Marks a folder for reconciliation in the next debounced run. */
  private queueReconcile(folder: string): void {
    logger.debug(`Detected change of extension folder: ${folder}`);
    this.pendingFolders.add(folder);
    this.scheduleDebouncedProcess();
  }

  /**
   * Schedules the debounced processing of pending changes.
   */
  private scheduleDebouncedProcess(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.enqueueRun();
    }, this.debounceMs);
  }

  /**
   * Appends a processing run to the chain, so loads and unloads never overlap.
   * The run takes everything pending when it starts.
   *
   * @returns Resolves when this run has finished
   */
  private enqueueRun(): Promise<void> {
    const run = this.processing.then(() =>
      this.processPending().catch((err) => {
        logger.error("Error processing pending extension changes:", err);
      }),
    );
    this.processing = run;
    return run;
  }

  /**
   * Decides what to do with a folder from its current state: unload when its
   * entry point is gone, load when nothing is loaded from it, reload when the
   * loaded tree was replaced or its entry point changed, nothing otherwise
   * (late or duplicate events).
   *
   * @param folder - Folder name below the watched directory
   * @returns The action, or null when the registry already matches the folder
   */
  private decide(folder: string): ReconcileAction | null {
    const dir = path.join(this.directory, folder);
    const present = existsSync(path.join(dir, "index.ts"));
    const loaded = this.registry.loadedNameForDir(dir) !== null;
    if (!present) return loaded || this.knownExtensions.has(folder) ? "unload" : null;
    if (!loaded) return "load";
    const recorded = this.loadedFingerprints.get(folder);
    return recorded !== undefined && recorded === treeFingerprint(dir) ? null : "reload";
  }

  /**
   * Processes all pending changes. Decisions are made first; then unloads,
   * reloads (unload + load), and fresh loads run in that order, so a manifest
   * name moving between folders is freed before it is loaded again.
   */
  private async processPending(): Promise<void> {
    const folders = new Set(this.pendingFolders);
    // A reconciliation supersedes a UI-only rebuild.
    const toRebuildUi = [...this.pendingUiRebuilds].filter((n) => !folders.has(n));
    const toReloadLocales = [...this.pendingLocaleReloads].filter((n) => !folders.has(n));
    this.pendingFolders.clear();
    this.pendingUiRebuilds.clear();
    this.pendingLocaleReloads.clear();

    const actions = new Map<ReconcileAction, string[]>([
      ["unload", []],
      ["reload", []],
      ["load", []],
    ]);
    for (const folder of folders) {
      const action = this.decide(folder);
      if (action) actions.get(action)!.push(folder);
    }

    for (const folder of actions.get("unload")!) await this.unloadExtension(folder);
    for (const folder of actions.get("reload")!) await this.reloadExtension(folder);
    for (const folder of actions.get("load")!) await this.loadExtension(folder);

    // Rebuild UI pages whose sources changed
    for (const extName of toRebuildUi) {
      const manifestName = this.dirToManifestName.get(extName) ?? extName;
      try {
        if (await this.registry.rebuildUi(manifestName)) {
          logger.info(`Rebuilt UI of extension "${manifestName}"`);
        }
      } catch (err) {
        logger.error(`Error rebuilding UI of extension "${manifestName}":`, err);
      }
    }

    // Reload translation catalogs that changed
    for (const extName of toReloadLocales) {
      const manifestName = this.dirToManifestName.get(extName) ?? extName;
      try {
        if (await this.registry.reloadLocales(manifestName)) {
          logger.info(`Reloaded translations of extension "${manifestName}"`);
        }
      } catch (err) {
        logger.error(`Error reloading translations of extension "${manifestName}":`, err);
      }
    }
  }

  /**
   * Attempts to load a single extension by directory name.
   * Runs ExternalDependencyResolver, then calls registry.loadOne().
   * Logs and skips on any error.
   */
  private async loadExtension(extName: string): Promise<void> {
    const extDir = path.join(this.directory, extName);
    const modulePath = path.join(extDir, "index.ts");

    // Final check: directory and index.ts must still exist
    if (!existsSync(modulePath)) {
      logger.warn(`Skipping load for "${extName}": index.ts no longer exists`);
      return;
    }

    logger.info(`Hot-loading external extension "${extName}"...`);
    // Taken before importing: a change during the load then differs and reloads.
    const fingerprint = treeFingerprint(extDir);

    try {
      // Snapshot loaded names before loading to detect the manifest name
      const beforeNames = new Set(this.registry.getLoadedExtensionInfo().map((i) => i.name));

      const success = await this.registry.loadOne(modulePath);
      if (success) {
        this.knownExtensions.add(extName);
        if (fingerprint) this.loadedFingerprints.set(extName, fingerprint);

        // Determine the manifest name by diffing loaded list
        const afterNames = this.registry.getLoadedExtensionInfo().map((i) => i.name);
        const newName = afterNames.find((n) => !beforeNames.has(n));
        if (newName && newName !== extName) {
          // Directory name differs from manifest name — track the mapping
          this.dirToManifestName.set(extName, newName);
        }

        logger.info(`Successfully hot-loaded extension "${extName}"`);
      } else {
        logger.warn(`Failed to hot-load extension "${extName}" (loadOne returned false)`);
      }
    } catch (err) {
      logger.error(`Error hot-loading extension "${extName}":`, err);
    }
  }

  /**
   * Attempts to unload a single extension by directory name.
   * Resolves the manifest name (which may differ from the directory name),
   * then calls registry.unloadOne() to deactivate and remove.
   * Skips silently if the extension is not currently loaded in the registry.
   * Logs and skips on any error.
   */
  private async unloadExtension(extName: string): Promise<void> {
    // The manifest name of what is loaded from this folder (it may differ from the folder name)
    const manifestName = this.registry.loadedNameForDir(path.join(this.directory, extName));

    if (!manifestName) {
      this.knownExtensions.delete(extName);
      this.dirToManifestName.delete(extName);
      this.loadedFingerprints.delete(extName);
      return;
    }

    logger.info(`Unloading external extension "${manifestName}" (dir: ${extName})...`);

    try {
      const success = await this.registry.unloadOne(manifestName);
      if (success) {
        this.knownExtensions.delete(extName);
        this.dirToManifestName.delete(extName);
        this.loadedFingerprints.delete(extName);
        logger.info(`Successfully unloaded extension "${manifestName}"`);
      } else {
        logger.warn(`Failed to unload extension "${manifestName}" (unloadOne returned false)`);
      }
    } catch (err) {
      logger.error(`Error unloading extension "${manifestName}":`, err);
    }
  }

  /**
   * Reloads an extension: unloads the current version, then loads fresh.
   * Used when index.ts changes for an already-loaded extension (e.g., cp over existing dir).
   */
  private async reloadExtension(extName: string): Promise<void> {
    const manifestName = this.registry.loadedNameForDir(path.join(this.directory, extName));
    logger.info(`Reloading external extension "${manifestName ?? extName}" (dir: ${extName})...`);

    // Unload the existing version (clears step types, tools, routes, etc.)
    if (manifestName) {
      try {
        const success = await this.registry.unloadOne(manifestName);
        if (!success) {
          logger.warn(`Failed to unload "${manifestName}" during reload`);
          return;
        }
      } catch (err) {
        logger.error(`Error unloading "${manifestName}" during reload:`, err);
        return;
      }
    }

    // Clear the old mapping (the new version might have a different manifest name)
    this.dirToManifestName.delete(extName);
    this.loadedFingerprints.delete(extName);

    // Load the new version
    await this.loadExtension(extName);
  }
}
