/**
 * ExtensionRegistry - discovers, validates, loads, and manages the lifecycle
 * of all extensions. Central orchestrator for the extension system.
 */

import type { FSWatcher } from "node:fs";
import { watch as fsWatch } from "node:fs";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ExtensionInfo, WebSocketMessage } from "@shared/types";
import { Value } from "@sinclair/typebox/value";
import { serverOrigin } from "@src/config";
import { getDb, schema } from "@src/db";
import type { PushMessageFn } from "@src/push";
import type { ManagedQueuePort, QueueJob } from "@src/queue";
import type { SecretVault } from "@src/secrets/vault";
import type { SessionStorePort } from "@src/session";
import {
  discoverExtensionSkills,
  discoverSkills as discoverSkillsFn,
  loadSkillScripts as loadSkillScriptsFn,
} from "@src/skills/loader";
import type { SkillEntry } from "@src/tools/sandbox";
import { formatValidationErrors } from "@src/utils/validation";
import { FlowProducer } from "bunqueue/client";
import { eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import createLogger from "logging";
import { resolveDependencyOrder } from "./dependencyResolver";
import { EventBus } from "./eventBus";
import { createExtensionContext } from "./extensionContext";
import type { LoadedExtension } from "./internalTypes";
import type { RouteRegistry } from "./types";
import {
  type AgentProcessorResult,
  type CoreQueueName,
  type Extension,
  ExtensionManifestSchema,
  type RunAgentOptions,
} from "./types";

const logger = createLogger("ExtensionRegistry");

/**
 * Dependencies passed to {@link ExtensionRegistry.initializeAll} once all
 * subsystems are ready. Replaces the old lazy-getter pattern with explicit
 * pass-at-init semantics - no mutable state, no temporal coupling.
 */
export interface RegistryInitDeps {
  /** Route registration surface for wiring extension routes (wraps the Elysia app internally). */
  routeRegistry: RouteRegistry;
  /** Broadcast a WebSocket message to all connected clients. */
  broadcastFn: (message: WebSocketMessage) => void;
  /** Callback invoked when an extension creates a queue during loading. */
  onQueueCreated?: (queue: ManagedQueuePort) => void;
  /** The shared Drizzle database instance. */
  database: BunSQLiteDatabase<Record<string, unknown>>;
  /** Runs a sub-agent to completion. */
  runAgentFn: (job: QueueJob<unknown>, opts: RunAgentOptions) => Promise<AgentProcessorResult>;
  /** The shared session store instance. */
  sessionStore: SessionStorePort;
  /** Programmatic push message function. */
  pushMessageFn?: PushMessageFn;
  /** The SQLite-backed encrypted secret vault (optional - disabled when no master key is configured). */
  secretVault?: SecretVault;
}

export interface ExtensionRegistryConfig {
  /** Directories to scan for extensions. The first entry is treated as the primary (built-in) directory. */
  extensionDirs: string[];
  workDir: string;
  /** Absolute path to the data directory (databases, generated content). */
  dataDir: string;
  /** Optional lookup function for core (non-extension) managed queues by name. */
  getCoreQueueFn?: (name: CoreQueueName) => ManagedQueuePort | undefined;
  /** Optional callback invoked when the skill map changes at runtime. */
  onSkillMapChanged?: () => void;
}

export class ExtensionRegistry {
  /** All extension directories to scan. First entry is the primary (built-in) directory. */
  private readonly extensionDirs: string[];
  private readonly workDir: string;
  private readonly dataDir: string;
  private readonly eventBus = new EventBus();

  private readonly getCoreQueueFn?: (name: CoreQueueName) => ManagedQueuePort | undefined;
  private readonly onSkillMapChanged?: () => void;

  /** Shared FlowProducer instance for creating job flows/chains. */
  private readonly flowProducer: FlowProducer;

  /** Resolved init deps - set once by {@link initializeAll}. */
  private initDeps?: RegistryInitDeps;

  /** Ordered list of loaded extensions (initialization order). */
  private loaded: Array<{ name: string } & LoadedExtension> = [];

  /** Global tool name set - prevents duplicates across extensions and core. */
  private readonly toolNameSet = new Set<string>();

  /** Global route key set - "METHOD:/full/path" */
  private readonly routeKeySet = new Set<string>();

  /** Skill name -> SkillEntry map, populated during discovery. */
  private readonly skillMap = new Map<string, SkillEntry>();

  /** File watchers for hot-reloading skills when extensions change. One per directory. */
  private skillWatchers: Array<{ handle: FSWatcher; dir: string }> = [];

  /** Route prefixes for unloaded extensions - checked by the web server route guard. */
  private readonly disabledRoutePrefixes = new Set<string>();

  /** Debounce timer for skill map re-scans. */
  private skillWatcherTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: ExtensionRegistryConfig) {
    this.extensionDirs = config.extensionDirs;
    this.workDir = config.workDir;
    this.dataDir = config.dataDir;
    this.getCoreQueueFn = config.getCoreQueueFn;
    this.onSkillMapChanged = config.onSkillMapChanged;
    this.flowProducer = new FlowProducer({ embedded: true });
  }

  /** The built-in extensions directory - used by the skill watcher and exposed to extensions. */
  private get builtinExtensionsDir(): string {
    return this.extensionDirs[0]!;
  }

  /**
   * Returns the set of extension names discovered from the built-in directory.
   * Used to prevent unloading built-in extensions at runtime.
   */
  private getBuiltinExtensionNames(): ReadonlySet<string> {
    const names = new Set<string>();
    const patterns = ["*/index.ts", "core/*/index.ts"];
    try {
      for (const pattern of patterns) {
        const glob = new Bun.Glob(pattern);
        for (const entry of glob.scanSync({ cwd: this.builtinExtensionsDir, absolute: false })) {
          const parts = entry.split("/");
          // For "core/scheduler/index.ts" -> "scheduler", for "steering/index.ts" -> "steering"
          const extName = parts.length === 3 ? parts[1]! : parts[0]!;
          names.add(extName);
        }
      }
    } catch {
      // Directory not readable - return empty set
    }
    return names;
  }

  /**
   * Register core tool names so extensions can't collide with them.
   */
  registerCoreTools(tools: AgentTool[]): void {
    for (const tool of tools) {
      this.toolNameSet.add(tool.name);
    }
  }

  /** Returns the shared event bus for wiring events. */
  getEventBus(): EventBus {
    return this.eventBus;
  }

  /**
   * Returns the set of disabled route prefixes (for unloaded extensions).
   * The web server uses this to return 404 for routes belonging to
   * extensions that have been unloaded at runtime.
   */
  getDisabledRoutePrefixes(): ReadonlySet<string> {
    return this.disabledRoutePrefixes;
  }

  /**
   * Resolve a skill name to its {@link SkillEntry}.
   * Returns `undefined` if the skill does not exist or its owning
   * extension is disabled.
   *
   * @param name - The skill name to look up
   * @returns The skill entry, or undefined if not found or disabled
   */
  resolveSkill(name: string): SkillEntry | undefined {
    const entry = this.skillMap.get(name);
    if (!entry || !this.isExtensionEnabled(entry.extensionName)) {
      return undefined;
    }

    return entry;
  }

  /**
   * Returns skill names whose owning extension is enabled.
   */
  getSkillNames(): string[] {
    return [...this.skillMap.entries()]
      .filter(([, entry]) => this.isExtensionEnabled(entry.extensionName))
      .map(([name]) => name);
  }

  /**
   * Returns the full skill map (read-only view).
   */
  getSkillMap(): ReadonlyMap<string, SkillEntry> {
    return this.skillMap;
  }

  /**
   * Scan all extension directories for co-located skills and populate
   * the skill map. Delegates to the shared loader in `src/skills/loader.ts`.
   */
  private async discoverSkills(): Promise<void> {
    this.skillMap.clear();

    const discovered = await discoverSkillsFn(this.extensionDirs);
    for (const [name, entry] of discovered) {
      this.skillMap.set(name, entry);
    }
  }

  /**
   * Load skill scripts for all discovered skills. Delegates to the
   * shared loader in `src/skills/loader.ts`.
   */
  private async loadSkillScripts(): Promise<void> {
    await loadSkillScriptsFn(this.skillMap, this.builtinExtensionsDir);
  }

  /**
   * Start watching the extensions directory for skill-related changes.
   * Debounces re-scans to avoid excessive I/O.
   */
  private startSkillWatcher(): void {
    const dirs = this.extensionDirs.filter((d): d is string => d != null);

    for (const dir of dirs) {
      try {
        const handle = fsWatch(dir, { recursive: true }, (_event, filename) => {
          if (!filename) return;
          // Only react to changes in skills/ subdirectories or SKILL.md files
          if (!filename.includes("skills/") && !filename.endsWith("SKILL.md")) return;

          if (this.skillWatcherTimer) clearTimeout(this.skillWatcherTimer);
          this.skillWatcherTimer = setTimeout(async () => {
            this.skillWatcherTimer = null;
            logger.info("Skill files changed - re-scanning...");
            await this.discoverSkills();
            await this.loadSkillScripts();
            this.onSkillMapChanged?.();
          }, 500);
        });
        handle.on("error", (err) => logger.error(`Skill watcher error for ${dir}:`, err));
        this.skillWatchers.push({ handle, dir });
      } catch (err) {
        logger.debug(`Could not start skill file watcher for ${dir}:`, err);
      }
    }

    logger.info(`Watching extension directories for skill changes: ${dirs.join(", ")}`);
  }

  /**
   * Discover skills and load their scripts without initializing extensions.
   * Called early in the boot sequence before the web server exists.
   */
  async discoverAndLoadSkills(): Promise<void> {
    await this.discoverSkills();
    await this.loadSkillScripts();
  }

  /**
   * Discover extension modules, resolve dependencies, and initialize
   * each extension in dependency order. Skills must already be discovered.
   *
   * @param deps - All runtime dependencies needed by extensions during initialization
   */
  async initializeAll(deps: RegistryInitDeps): Promise<void> {
    this.initDeps = deps;

    const discovered = await this.discoverExtensions();
    if (discovered.length === 0) {
      logger.info("No extensions discovered");
      this.startSkillWatcher();
      return;
    }

    // Resolve dependency order
    const { ordered, excluded, errors } = resolveDependencyOrder(discovered);
    for (const err of errors) {
      logger.error(err);
    }
    for (const ext of excluded) {
      logger.warn(`Extension "${ext.manifest.name}" excluded from loading`);
    }

    // Initialize in dependency order
    for (const ext of ordered) {
      const name = ext.manifest.name;

      // Skip initialization for extensions disabled in the database (start as suspended)
      if (!ext.manifest.core && !this.isExtensionEnabled(name)) {
        this.loaded.push({
          name,
          extension: ext,
          tools: [],
          routes: [],
          queues: [],
          state: "suspended",
        });
        logger.debug(`Extension "${name}" is disabled - loaded as suspended`);
        continue;
      }

      await this.initializeExtension(ext);
    }

    // Warn about cross-extension route collisions (do not reject)
    this.warnCrossExtensionRouteCollisions();

    logger.info(
      `Loaded ${this.loaded.length} extension(s): ${this.loaded
        .toSorted((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
        .map((l) => l.name)
        .join(", ")}`,
    );

    // Start watching for skill changes after everything is loaded
    this.startSkillWatcher();
  }

  /**
   * Scan the extensions directory (and any additional directories) for
   * subdirectories containing index.ts. Supports both top-level extensions
   * and extensions nested under core/.
   */
  private async discoverExtensions(): Promise<Extension[]> {
    const extensions: Extension[] = [];
    const dirs = this.extensionDirs;
    const patterns = ["*/index.ts", "core/*/index.ts"];

    for (const dir of dirs) {
      try {
        for (const pattern of patterns) {
          const glob = new Bun.Glob(pattern);
          for (const entry of glob.scanSync({ cwd: dir, absolute: false })) {
            const modulePath = `${dir}/${entry}`;
            const ext = await this.loadExtensionModule(modulePath);
            if (ext) extensions.push(ext);
          }
        }
      } catch {
        logger.warn(`Extensions directory not found or unreadable: ${dir}`);
      }
    }

    return extensions;
  }

  /**
   * Dynamically import a single extension module and validate its exports.
   */
  private async loadExtensionModule(modulePath: string): Promise<Extension | null> {
    try {
      const mod = await import(modulePath);
      const ext: Extension = mod.default ?? mod;

      if (!this.validateExtension(ext, modulePath)) {
        return null;
      }

      return ext;
    } catch (err) {
      logger.error(`Failed to import extension module at ${modulePath}:`, err);
      return null;
    }
  }

  /**
   * Validate that a module export satisfies the Extension interface.
   * Checks TypeBox schema conformance, settingsSchema shape, duplicate
   * routes within ui.navigation, and presence of lifecycle methods.
   */
  validateExtension(ext: unknown, modulePath: string): ext is Extension {
    if (!ext || typeof ext !== "object") {
      logger.error(`Extension at ${modulePath}: export is not an object`);
      return false;
    }

    const candidate = ext as Record<string, unknown>;

    // Validate manifest with TypeBox
    if (!candidate.manifest || !Value.Check(ExtensionManifestSchema, candidate.manifest)) {
      const errorDetail = candidate.manifest
        ? formatValidationErrors(ExtensionManifestSchema, candidate.manifest)
        : "missing manifest";
      logger.error(`Extension at ${modulePath}: invalid manifest - ${errorDetail}`);
      return false;
    }

    // Validate settingsSchema if present (must be a TObject with type "object" and properties)
    const manifest = candidate.manifest as Record<string, unknown>;
    if (manifest.settingsSchema != null) {
      const schema = manifest.settingsSchema as Record<string, unknown>;
      if (schema.type !== "object" || typeof schema.properties !== "object" || schema.properties === null) {
        logger.error(
          `Extension at ${modulePath}: settingsSchema must be a TypeBox Type.Object() (got type="${schema.type}")`,
        );
        return false;
      }
    }

    // Validate secretsSchema for duplicate key names (TypeBox catches structure, this catches duplicates)
    if (manifest.secretsSchema != null) {
      const secretsSchema = manifest.secretsSchema as Array<{ key: string }>;
      const keyNames = new Set<string>();
      const duplicates: string[] = [];
      for (const entry of secretsSchema) {
        if (keyNames.has(entry.key)) {
          duplicates.push(entry.key);
        }
        keyNames.add(entry.key);
      }
      if (duplicates.length > 0) {
        logger.warn(
          `Extension at ${modulePath}: secretsSchema has duplicate key names: ${duplicates.join(", ")} - skipping secrets schema`,
        );
        manifest.secretsSchema = undefined;
      }
    }

    // Check for duplicate routes within the manifest's ui.navigation array
    const ui = manifest.ui as { navigation?: Array<{ route: string }> } | undefined;
    if (ui?.navigation && ui.navigation.length > 0) {
      const routes = new Set<string>();
      for (const entry of ui.navigation) {
        if (routes.has(entry.route)) {
          logger.error(`Extension at ${modulePath}: duplicate route "${entry.route}" in ui.navigation`);
          return false;
        }
        routes.add(entry.route);
      }
    }

    if (typeof candidate.initialize !== "function") {
      logger.error(`Extension at ${modulePath}: missing initialize() method`);
      return false;
    }

    if (typeof candidate.shutdown !== "function") {
      logger.error(`Extension at ${modulePath}: missing shutdown() method`);
      return false;
    }

    return true;
  }

  /**
   * Log warnings for routes claimed by multiple extensions. Does not reject
   * any manifest - the first-loaded extension wins in the sidebar (sorted by order).
   */
  private warnCrossExtensionRouteCollisions(): void {
    const routeOwners = new Map<string, string[]>();

    for (const entry of this.loaded) {
      const ui = entry.extension.manifest.ui;
      if (!ui?.navigation) continue;
      for (const nav of ui.navigation) {
        const owners = routeOwners.get(nav.route);
        if (owners) {
          owners.push(entry.name);
        } else {
          routeOwners.set(nav.route, [entry.name]);
        }
      }
    }

    for (const [route, owners] of routeOwners) {
      if (owners.length > 1) {
        logger.warn(`Route "${route}" is declared by multiple extensions: ${owners.join(", ")}`);
      }
    }
  }

  /**
   * Initialize a single extension: create its context, call initialize(),
   * wire routes into Elysia, and track the loaded state.
   */
  private async initializeExtension(ext: Extension, modulePath?: string): Promise<void> {
    const name = ext.manifest.name;
    const deps = this.initDeps!;

    const { context, loaded } = createExtensionContext({
      extensionName: name,
      workDir: this.workDir,
      dataDir: this.dataDir,
      extensionsDir: this.builtinExtensionsDir,
      toolNameSet: this.toolNameSet,
      routeKeySet: this.routeKeySet,
      eventBus: this.eventBus,
      broadcastFn: deps.broadcastFn,
      flowProducer: this.flowProducer,
      resolveSkillFn: (n) => this.resolveSkill(n),
      database: deps.database,
      getCoreQueueFn: this.getCoreQueueFn,
      getExtensionQueuesFn: () => this.getRegisteredQueues(),
      runAgentFn: deps.runAgentFn,
      sessionStore: deps.sessionStore,
      pushMessageFn: deps.pushMessageFn,
      isExtensionEnabledFn: (n) => this.isExtensionEnabled(n),
      secretVault: deps.secretVault,
      routeRegistry: deps.routeRegistry,
      rescanSkillsFn: () => this.discoverAndLoadSkills(),
      getSkillNamesFn: () => this.getSkillNames(),
      loadOneFn: (path) => this.loadOne(path),
      unloadOneFn: (n) => this.unloadOne(n),
      externalExtensionsDir: this.extensionDirs[1],
      builtinExtensionNames: this.getBuiltinExtensionNames(),
      settingsSchema: ext.manifest.settingsSchema as Record<string, unknown> | undefined,
    });

    try {
      await ext.initialize(context);

      this.loaded.push({ name, extension: ext, modulePath, ...loaded, state: "active" });

      // Build a concise summary of what the extension registered
      const parts: string[] = [];
      if (loaded.tools.length > 0) parts.push(`${loaded.tools.length} tool(s)`);
      if (loaded.routes.length > 0) parts.push(`${loaded.routes.length} route(s)`);
      if (loaded.queues.length > 0) parts.push(`${loaded.queues.length} queue(s)`);
      const summary = parts.length > 0 ? ` (${parts.join(", ")})` : "";
      logger.info(`Initialized extension "${name}" v${ext.manifest.version}${summary}`);

      // Notify caller about any queues created by this extension
      if (deps.onQueueCreated) {
        for (const mq of loaded.queues) {
          deps.onQueueCreated(mq);
        }
      }
    } catch (err) {
      logger.error(`Failed to initialize extension "${name}":`, err);

      // Clean up any partial registrations from the failed context
      for (const tool of loaded.tools) {
        this.toolNameSet.delete(tool.name);
      }
      for (const route of loaded.routes) {
        this.routeKeySet.delete(`${route.method}:${route.fullPath}`);
      }
      this.eventBus.unsubscribeAll(name);
      for (const q of loaded.queues) {
        try {
          await q.close();
        } catch {
          // Ignore cleanup errors
        }
      }

      // Still add to loaded list as suspended so it remains visible in the UI
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.loaded.push({
        name,
        extension: ext,
        modulePath,
        tools: [],
        routes: [],
        queues: [],
        state: "suspended",
        error: errorMsg,
      });
    }
  }

  /**
   * Aggregate tools from all loaded extensions.
   * Suspended extensions have empty tool arrays, so no filtering is needed.
   */
  getRegisteredTools(): AgentTool[] {
    return this.loaded.flatMap((l) => l.tools);
  }

  /**
   * Aggregate queues from all loaded extensions.
   *
   * @returns Flat array of all extension-registered queues
   */
  getRegisteredQueues(): ManagedQueuePort[] {
    return this.loaded.flatMap((l) => l.queues);
  }

  /**
   * Check whether an extension is enabled by querying the
   * `extension_settings` table. Extensions with no row are
   * treated as disabled. Core extensions (manifest.core === true)
   * are always enabled regardless of database state.
   *
   * @param name - The extension manifest name
   * @returns `true` if the extension is enabled or has no settings row
   */
  private isExtensionEnabled(name: string): boolean {
    // Core extensions cannot be disabled
    const loaded = this.loaded.find((l) => l.name === name);
    if (loaded?.extension.manifest.core) return true;

    const db = getDb();
    const row = db
      .select({ enabled: schema.extensionSettings.enabled })
      .from(schema.extensionSettings)
      .where(eq(schema.extensionSettings.name, name))
      .get();
    return row ? row.enabled : false;
  }

  /**
   * Return metadata for all loaded extensions, merged with their
   * enabled/disabled state from the database.
   *
   * @returns Array of {@link ExtensionInfo} objects
   */
  getLoadedExtensionInfo(): ExtensionInfo[] {
    const builtinNames = this.getBuiltinExtensionNames();
    return this.loaded.map((l) => {
      let skillCount = 0;
      for (const entry of this.skillMap.values()) {
        if (entry.extensionName === l.name) skillCount++;
      }
      return {
        name: l.name,
        version: l.extension.manifest.version,
        description: l.extension.manifest.description ?? "",
        enabled: this.isExtensionEnabled(l.name),
        source: l.extension.manifest.core
          ? ("core" as const)
          : builtinNames.has(l.name)
            ? ("builtin" as const)
            : ("external" as const),
        core: l.extension.manifest.core ?? false,
        toolCount: l.tools.length,
        routeCount: l.routes.length,
        queueCount: l.queues.length,
        skillCount,
        settingsSchema: l.extension.manifest.settingsSchema ?? null,
        secretsSchema: l.extension.manifest.secretsSchema ?? null,
        error: l.error ?? null,
        ui: l.extension.manifest.ui ?? null,
      };
    });
  }

  /**
   * Dynamically load and initialize a single extension at runtime (post-boot).
   * Imports the module with cache-busting, validates, checks dependencies,
   * initializes, wires routes, discovers skills, and broadcasts a lifecycle event.
   *
   * @param modulePath - Absolute path to the extension's index.ts
   * @returns `true` on success, `false` on failure
   */
  async loadOne(modulePath: string): Promise<boolean> {
    if (!this.initDeps) {
      logger.error("Cannot loadOne before initializeAll has been called");
      return false;
    }

    // Import with cache-busting to bypass Bun's module cache
    const cacheBustedPath = `${modulePath}?v=${Date.now()}`;
    let ext: Extension | null = null;

    try {
      const mod = await import(cacheBustedPath);
      const candidate = mod.default ?? mod;

      if (!this.validateExtension(candidate, modulePath)) {
        return false;
      }

      ext = candidate;
    } catch (err) {
      logger.error(`Failed to import extension module at ${modulePath}:`, err);
      return false;
    }

    const name = ext.manifest.name;

    // Check for duplicate name
    if (this.loaded.some((l) => l.name === name)) {
      logger.error(`Cannot load extension "${name}": already loaded`);
      return false;
    }

    // Check dependencies against currently loaded extensions
    const deps = ext.manifest.dependencies ?? [];
    const loadedNames = new Set(this.loaded.map((l) => l.name));
    const missingDeps = deps.filter((dep) => !loadedNames.has(dep));
    if (missingDeps.length > 0) {
      logger.error(`Cannot load extension "${name}": missing dependencies: ${missingDeps.join(", ")}`);
      return false;
    }

    // Add to loaded list as suspended, then activate
    this.loaded.push({
      name,
      extension: ext,
      modulePath,
      tools: [],
      routes: [],
      queues: [],
      state: "suspended",
    });

    try {
      await this.activate(name);
    } catch (err) {
      logger.error(`Failed to activate extension "${name}":`, err);
      // Extension remains in loaded list as suspended
      return false;
    }

    // Discover skills for this extension
    const extDir = modulePath.replace(/\/index\.ts$/, "");
    const skillsFound = await this.discoverSkillsForExtension(name, extDir);
    if (skillsFound) {
      this.onSkillMapChanged?.();
    }

    // Broadcast "loaded" lifecycle event (distinct from "activated" which activate() already sent)
    this.initDeps.broadcastFn({
      type: "extension_lifecycle",
      action: "loaded",
      name,
      version: ext.manifest.version,
    });

    logger.info(`Hot-loaded extension "${name}" v${ext.manifest.version}`);
    return true;
  }

  /**
   * Deactivate a loaded extension: calls shutdown(), tears down all registrations
   * (tools, routes, queues, events), and transitions the extension to suspended state.
   * The extension remains in the loaded list for re-activation later.
   *
   * No-op if the extension is already suspended.
   *
   * @param name - The extension manifest name to deactivate
   * @throws If no extension with the given name is loaded
   */
  async deactivate(name: string): Promise<void> {
    const entry = this.loaded.find((l) => l.name === name);
    if (!entry) {
      throw new Error(`Cannot deactivate extension "${name}": not found in loaded list`);
    }

    // No-op if already suspended
    if (entry.state === "suspended") {
      return;
    }

    // Shutdown the extension (errors are logged but don't prevent cleanup)
    try {
      await entry.extension.shutdown();
      logger.debug(`Shut down extension "${name}"`);
    } catch (err) {
      logger.error(`Error shutting down extension "${name}":`, err);
    }

    // Clean up tools from the global set
    for (const tool of entry.tools) {
      this.toolNameSet.delete(tool.name);
    }

    // Clean up route keys and add prefix to disabled set
    for (const route of entry.routes) {
      this.routeKeySet.delete(`${route.method}:${route.fullPath}`);
    }
    this.disabledRoutePrefixes.add(`/ext/${name}`);

    // Clean up event subscriptions
    this.eventBus.unsubscribeAll(name);

    // Close queues
    for (const q of entry.queues) {
      try {
        await q.close();
      } catch (err) {
        logger.error(`Error closing queue for extension "${name}":`, err);
      }
    }

    // Clear registrations and transition to suspended
    entry.tools = [];
    entry.routes = [];
    entry.queues = [];
    entry.state = "suspended";

    // Broadcast lifecycle event
    if (this.initDeps) {
      this.initDeps.broadcastFn({
        type: "extension_lifecycle",
        action: "deactivated",
        name,
        version: entry.extension.manifest.version,
      });
    }

    logger.info(`Deactivated extension "${name}"`);
  }

  /**
   * Activate a suspended extension: creates a fresh ExtensionContext, calls
   * initialize(), wires registrations, and transitions to active state.
   *
   * No-op if the extension is already active.
   *
   * @param name - The extension manifest name to activate
   * @throws If no extension with the given name is loaded, or if initialize() fails
   */
  async activate(name: string): Promise<void> {
    const entry = this.loaded.find((l) => l.name === name);
    if (!entry) {
      throw new Error(`Cannot activate extension "${name}": not found in loaded list`);
    }

    // No-op if already active
    if (entry.state === "active") {
      return;
    }

    const deps = this.initDeps;
    if (!deps) {
      throw new Error(`Cannot activate extension "${name}": registry not initialized`);
    }

    const ext = entry.extension;

    // Create a fresh context
    const { context, loaded } = createExtensionContext({
      extensionName: name,
      workDir: this.workDir,
      dataDir: this.dataDir,
      extensionsDir: this.builtinExtensionsDir,
      toolNameSet: this.toolNameSet,
      routeKeySet: this.routeKeySet,
      eventBus: this.eventBus,
      broadcastFn: deps.broadcastFn,
      flowProducer: this.flowProducer,
      resolveSkillFn: (n) => this.resolveSkill(n),
      database: deps.database,
      getCoreQueueFn: this.getCoreQueueFn,
      getExtensionQueuesFn: () => this.getRegisteredQueues(),
      runAgentFn: deps.runAgentFn,
      sessionStore: deps.sessionStore,
      pushMessageFn: deps.pushMessageFn,
      isExtensionEnabledFn: (n) => this.isExtensionEnabled(n),
      secretVault: deps.secretVault,
      routeRegistry: deps.routeRegistry,
      rescanSkillsFn: () => this.discoverAndLoadSkills(),
      getSkillNamesFn: () => this.getSkillNames(),
      loadOneFn: (path) => this.loadOne(path),
      unloadOneFn: (n) => this.unloadOne(n),
      externalExtensionsDir: this.extensionDirs[1],
      builtinExtensionNames: this.getBuiltinExtensionNames(),
      settingsSchema: ext.manifest.settingsSchema as Record<string, unknown> | undefined,
    });

    try {
      await ext.initialize(context);
    } catch (err) {
      // Partial registration cleanup on failed initialize
      for (const tool of loaded.tools) {
        this.toolNameSet.delete(tool.name);
      }
      for (const route of loaded.routes) {
        this.routeKeySet.delete(`${route.method}:${route.fullPath}`);
      }
      this.eventBus.unsubscribeAll(name);
      for (const q of loaded.queues) {
        try {
          await q.close();
        } catch {
          // Ignore cleanup errors
        }
      }
      // Store error on the entry so it's visible in the UI
      entry.error = err instanceof Error ? err.message : String(err);
      throw err;
    }

    // Update the loaded entry with new registrations
    entry.tools = loaded.tools;
    entry.routes = loaded.routes;
    entry.queues = loaded.queues;
    entry.state = "active";
    entry.error = null;

    // Remove from disabled route prefixes
    this.disabledRoutePrefixes.delete(`/ext/${name}`);

    // Notify monitor about any queues created
    if (deps.onQueueCreated) {
      for (const mq of loaded.queues) {
        deps.onQueueCreated(mq);
      }
    }

    // Broadcast lifecycle event
    deps.broadcastFn({
      type: "extension_lifecycle",
      action: "activated",
      name,
      version: ext.manifest.version,
    });

    logger.info(`Activated extension "${name}" v${ext.manifest.version}`);
  }

  /**
   * Unload a single extension at runtime: deactivates it, removes it from
   * the loaded list, cleans up skills, and broadcasts a lifecycle event.
   *
   * @param name - The extension manifest name to unload
   * @returns `true` on success, `false` if extension not found
   */
  async unloadOne(name: string): Promise<boolean> {
    const idx = this.loaded.findIndex((l) => l.name === name);
    if (idx === -1) {
      logger.warn(`Cannot unload extension "${name}": not found in loaded list`);
      return false;
    }

    const entry = this.loaded[idx]!;
    const version = entry.extension.manifest.version;

    // Deactivate (shutdown + cleanup) -- no-op if already suspended
    await this.deactivate(name);

    // Remove from loaded list
    this.loaded.splice(idx, 1);

    // Remove skills owned by this extension
    let skillsRemoved = false;
    for (const [skillName, skillEntry] of this.skillMap) {
      if (skillEntry.extensionName === name) {
        this.skillMap.delete(skillName);
        skillsRemoved = true;
      }
    }
    if (skillsRemoved) {
      this.onSkillMapChanged?.();
    }

    // Broadcast lifecycle event
    if (this.initDeps) {
      this.initDeps.broadcastFn({
        type: "extension_lifecycle",
        action: "unloaded",
        name,
        version,
      });
    }

    logger.info(`Unloaded extension "${name}" v${version}`);
    return true;
  }

  /**
   * Discover skills for a single extension directory and merge into the skill map.
   *
   * @param extensionName - The extension name that owns these skills
   * @param extDir - Absolute path to the extension directory
   * @returns `true` if any skills were discovered
   */
  private async discoverSkillsForExtension(extensionName: string, extDir: string): Promise<boolean> {
    return discoverExtensionSkills(extensionName, extDir, this.skillMap);
  }

  /**
   * Shutdown all extensions in reverse initialization order.
   * Catches and logs errors per extension so one failure doesn't block others.
   */
  async shutdownAll(): Promise<void> {
    // Stop all skill watchers
    for (const w of this.skillWatchers) {
      try {
        w.handle.close();
      } catch {
        /* ignore */
      }
    }
    this.skillWatchers = [];
    if (this.skillWatcherTimer) {
      clearTimeout(this.skillWatcherTimer);
      this.skillWatcherTimer = null;
    }

    // Reverse init order
    const reversed = [...this.loaded].reverse();

    for (const entry of reversed) {
      try {
        await entry.extension.shutdown();
        logger.debug(`Shut down extension "${entry.name}"`);
      } catch (err) {
        logger.error(`Error shutting down extension "${entry.name}":`, err);
      }

      // Clean up tools from the global set
      for (const tool of entry.tools) {
        this.toolNameSet.delete(tool.name);
      }

      // Clean up route keys from the global set
      for (const route of entry.routes) {
        this.routeKeySet.delete(`${route.method}:${route.fullPath}`);
      }

      // Clean up event subscriptions
      this.eventBus.unsubscribeAll(entry.name);

      // Close queues (handles both worker and queue internally)
      for (const q of entry.queues) {
        try {
          await q.close();
        } catch (err) {
          logger.error(`Error closing queue for extension "${entry.name}":`, err);
        }
      }
    }

    this.loaded = [];
    logger.info("All extensions shut down");

    // Close the shared FlowProducer
    await this.flowProducer.close();
  }
}

// ---------------------------------------------------------------------------
// Re-export from config for backwards-compat (extension consumers may import it)
export { serverOrigin } from "@src/config";

/**
 * Constructs the HTTP base URL for an extension's routes.
 *
 * Extension routes are served at `/ext/{extensionName}/`, so this returns
 * e.g. `http://localhost:3000/ext/introspection`. Skill scripts should
 * receive this via the {@link SkillScriptContext.baseUrl} parameter of
 * `registerSkill` rather than importing host/port from config directly.
 *
 * @param extensionName - The extension name (matches the route prefix)
 * @returns Fully-qualified base URL with no trailing slash
 */
export function getExtensionBaseUrl(extensionName: string): string {
  return `${serverOrigin()}/ext/${extensionName}`;
}
