/**
 * Watches EXTERNAL_EXTENSIONS_DIR for new or removed extension directories
 * and automatically loads/unloads them at runtime without restart.
 *
 * Detection logic:
 * - A directory is considered a valid extension when it contains an `index.ts` file.
 * - New directories trigger ExternalDependencyResolver + loadOne().
 * - Removed directories trigger unloadOne().
 * - All events are debounced to batch rapid filesystem changes.
 */

import { existsSync } from "node:fs";
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

/**
 * Watches the external extensions directory for added/removed extension folders
 * and triggers hot-load or unload via the ExtensionRegistry.
 */
export class ExtensionWatcher {
  private readonly directory: string;
  private readonly registry: ExtensionRegistry;
  private readonly debounceMs: number;

  private watcher: FSWatcher | null = null;

  /** Pending directories to load (debounce accumulator). */
  private pendingLoads = new Set<string>();
  /** Pending extension names to unload (debounce accumulator). */
  private pendingUnloads = new Set<string>();
  /** Pending extension directories to reload (unload + load). */
  private pendingReloads = new Set<string>();
  /** Debounce timer handle. */
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Tracks known extension directories (dirname -> true). */
  private knownExtensions = new Set<string>();

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
      depth: 2, // Watch up to <ext-dir>/<name>/index.ts
      usePolling: false,
      // Ignore node_modules and hidden files within extension directories
      ignored: ["**/node_modules/**", "**/.git/**", "**/tsconfig.json", "**/tsconfig.json.tmp"],
    });

    this.watcher.on("add", (filePath) => this.handleFileAdd(filePath));
    this.watcher.on("change", (filePath) => this.handleFileChange(filePath));
    this.watcher.on("addDir", (dirPath) => this.handleDirAdd(dirPath));
    this.watcher.on("unlinkDir", (dirPath) => this.handleDirRemove(dirPath));
    this.watcher.on("unlink", (filePath) => this.handleFileRemove(filePath));
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
    this.pendingLoads.clear();
    this.pendingUnloads.clear();
    this.pendingReloads.clear();
    this.dirToManifestName.clear();
  }

  /**
   * Seeds the known extensions set from both the registry's loaded list and
   * the current filesystem state. This prevents the watcher from emitting
   * spurious load/unload events for directories that already existed at start.
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
        }
      }
    } catch {
      // Directory unreadable - continue with what we have
    }
  }

  /**
   * Handles a new file appearing in the watch tree.
   * We only care about `index.ts` files at the expected depth.
   */
  private handleFileAdd(filePath: string): void {
    const relative = path.relative(this.directory, filePath);
    const parts = relative.split(path.sep);

    // Pattern: <extension-name>/index.ts
    if (parts.length === 2 && parts[1] === "index.ts") {
      const extName = parts[0]!;

      // If already pending unload, convert to reload (rm + cp scenario)
      if (this.pendingUnloads.has(extName)) {
        this.pendingUnloads.delete(extName);
        this.pendingReloads.add(extName);
        this.scheduleDebouncedProcess();
        return;
      }

      if (this.knownExtensions.has(extName)) return;

      logger.debug(`Detected new extension entry point: ${extName}/index.ts`);
      this.pendingLoads.add(extName);
      this.pendingUnloads.delete(extName);
      this.scheduleDebouncedProcess();
    }
  }

  /**
   * Handles a file change in the watch tree.
   * If index.ts of a known (loaded) extension changes, schedule a reload (unload + load).
   */
  private handleFileChange(filePath: string): void {
    const relative = path.relative(this.directory, filePath);
    const parts = relative.split(path.sep);

    // Pattern: <extension-name>/index.ts changed
    if (parts.length === 2 && parts[1] === "index.ts") {
      const extName = parts[0]!;
      if (!this.knownExtensions.has(extName)) return;

      logger.debug(`Detected extension entry point change: ${extName}/index.ts`);
      this.pendingReloads.add(extName);
      // Remove from simple load/unload sets to avoid double-processing
      this.pendingLoads.delete(extName);
      this.pendingUnloads.delete(extName);
      this.scheduleDebouncedProcess();
    }
  }

  /**
   * Handles a new directory appearing. If a directory is created and already
   * contains index.ts (e.g., copied as a whole), chokidar may emit addDir
   * before individual file events. We check for index.ts proactively.
   */
  private handleDirAdd(dirPath: string): void {
    const relative = path.relative(this.directory, dirPath);
    const parts = relative.split(path.sep);

    // Pattern: <extension-name> (direct child of EXTERNAL_EXTENSIONS_DIR)
    if (parts.length === 1 && parts[0] && parts[0] !== ".") {
      const extName = parts[0];
      if (this.knownExtensions.has(extName)) return;

      const indexPath = path.join(dirPath, "index.ts");
      if (existsSync(indexPath)) {
        logger.debug(`Detected new extension directory with index.ts: ${extName}`);
        this.pendingLoads.add(extName);
        this.pendingUnloads.delete(extName);
        this.scheduleDebouncedProcess();
      }
    }
  }

  /**
   * Handles removal of a directory. If an extension's root directory is removed,
   * schedule it for unloading.
   */
  private handleDirRemove(dirPath: string): void {
    const relative = path.relative(this.directory, dirPath);
    const parts = relative.split(path.sep);

    // Pattern: <extension-name> (direct child removed)
    if (parts.length === 1 && parts[0] && parts[0] !== ".") {
      const extName = parts[0];
      if (!this.knownExtensions.has(extName)) return;

      logger.debug(`Detected extension directory removal: ${extName}`);
      this.pendingUnloads.add(extName);
      this.pendingLoads.delete(extName);
      this.scheduleDebouncedProcess();
    }
  }

  /**
   * Handles removal of a file. If index.ts is deleted from an extension directory,
   * treat it as an extension removal.
   */
  private handleFileRemove(filePath: string): void {
    const relative = path.relative(this.directory, filePath);
    const parts = relative.split(path.sep);

    // Pattern: <extension-name>/index.ts removed
    if (parts.length === 2 && parts[1] === "index.ts") {
      const extName = parts[0]!;
      if (!this.knownExtensions.has(extName)) return;

      logger.debug(`Detected extension entry point removal: ${extName}/index.ts`);
      this.pendingUnloads.add(extName);
      this.pendingLoads.delete(extName);
      this.scheduleDebouncedProcess();
    }
  }

  /**
   * Schedules the debounced processing of pending load/unload operations.
   */
  private scheduleDebouncedProcess(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.processPending().catch((err) => {
        logger.error("Error processing pending extension changes:", err);
      });
    }, this.debounceMs);
  }

  /**
   * Processes all pending load, unload, and reload operations.
   * Order: unloads first, then reloads (unload+load), then fresh loads.
   */
  private async processPending(): Promise<void> {
    // Snapshot and clear pending sets
    const toUnload = [...this.pendingUnloads];
    const toReload = [...this.pendingReloads];
    const toLoad = [...this.pendingLoads];
    this.pendingUnloads.clear();
    this.pendingReloads.clear();
    this.pendingLoads.clear();

    // Process unloads first
    for (const extName of toUnload) {
      await this.unloadExtension(extName);
    }

    // Process reloads (unload then load)
    for (const extName of toReload) {
      await this.reloadExtension(extName);
    }

    // Process fresh loads
    for (const extName of toLoad) {
      await this.loadExtension(extName);
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

    try {
      // Snapshot loaded names before loading to detect the manifest name
      const beforeNames = new Set(this.registry.getLoadedExtensionInfo().map((i) => i.name));

      const success = await this.registry.loadOne(modulePath);
      if (success) {
        this.knownExtensions.add(extName);

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
    // Resolve the manifest name: it may differ from the directory name
    const manifestName = this.dirToManifestName.get(extName) ?? extName;

    // Only attempt unload if the extension is actually in the registry's loaded list.
    const infos = this.registry.getLoadedExtensionInfo();
    const isLoaded = infos.some((i) => i.name === manifestName);

    if (!isLoaded) {
      this.knownExtensions.delete(extName);
      this.dirToManifestName.delete(extName);
      return;
    }

    logger.info(`Unloading external extension "${manifestName}" (dir: ${extName})...`);

    try {
      const success = await this.registry.unloadOne(manifestName);
      if (success) {
        this.knownExtensions.delete(extName);
        this.dirToManifestName.delete(extName);
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
    const manifestName = this.dirToManifestName.get(extName) ?? extName;
    logger.info(`Reloading external extension "${manifestName}" (dir: ${extName})...`);

    // Unload the existing version (clears step types, tools, routes, etc.)
    const infos = this.registry.getLoadedExtensionInfo();
    const isLoaded = infos.some((i) => i.name === manifestName);
    if (isLoaded) {
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

    // Load the new version
    await this.loadExtension(extName);
  }
}
