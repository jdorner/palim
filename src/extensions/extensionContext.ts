/**
 * ExtensionContext implementation - the scoped interface passed to each
 * extension during initialization, providing controlled access to the
 * core system's hook points (tools, routes, queues, events, config,
 * database, and agent execution).
 */

import type { RouteRegistry } from "@ext/types";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { WebSocketMessage } from "@shared/types";
import { schema } from "@src/db";
import type { PushMessageFn } from "@src/push";
import type { JobInfo, JobProcessor, ManagedQueueOptions, ManagedQueuePort, QueueJob, QueueJobLogs } from "@src/queue";
import { ManagedQueue } from "@src/queue";
import type { SetSecretOptions } from "@src/secrets";
import type { SecretVault } from "@src/secrets/vault";
import type { SessionStorePort } from "@src/session";
import type { SkillEntry } from "@src/tools/sandbox";
import { authenticatedFetch } from "@src/utils/fetch";
import { registerDynamicItemProvider as registerProviderFn } from "@src/web/dynamicItemProviders";
import type { FlowProducer } from "bunqueue/client";
import { eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import createLogger from "logging";
import type { EventBus } from "./eventBus";
import type { LoadedExtension, RegisteredRoute, RegisteredStepType } from "./internalTypes";
import type {
  AgentEventContext,
  AgentProcessorResult,
  ConfigValue,
  CoreQueueName,
  EventCallback,
  EventParam,
  EventType,
  ExtensionContext,
  HttpMethod,
  QueueEventName,
  RouteHandler,
  RunAgentOptions,
  StepTypeHandler,
} from "./types";

const logger = createLogger("ExtensionContext");

/**
 * Dependencies injected from the registry so the context can wire into
 * the core system without owning those resources directly.
 *
 * Grouped by concern for readability. The top-level interface composes
 * these sub-groups into a single object passed to {@link createExtensionContext}.
 */

/** Identity and filesystem paths for this extension context. */
export interface ExtContextIdentity {
  /** The extension name this context is scoped to. */
  extensionName: string;
  /** Absolute path to the agent's working directory. */
  workDir: string;
  /** Absolute path to the data directory (databases, generated content). */
  dataDir: string;
  /** Absolute path to the extensions directory. */
  extensionsDir: string;
  /** Absolute path to the external extensions directory (for path validation). */
  externalExtensionsDir?: string;
}

/** Tool and route registration surfaces. */
export interface ExtContextRegistration {
  /** Global set of tool names already claimed (core + other extensions). */
  toolNameSet: Set<string>;
  /** Global set of "METHOD:/full/path" strings to detect route collisions. */
  routeKeySet: Set<string>;
  /** Global set of step type names already claimed (for duplicate detection). */
  stepTypeNameSet: Set<string>;
  /** Route registry for wiring routes directly into the HTTP server. */
  routeRegistry?: RouteRegistry;
}

/** Event bus and WebSocket broadcasting. */
export interface ExtContextEvents {
  /** The shared event bus instance. */
  eventBus: EventBus;
  /** Callback to broadcast a WebSocket message to all connected clients. */
  broadcastFn?: (message: WebSocketMessage) => void;
}

/** Agent execution and queue infrastructure. */
export interface ExtContextAgent {
  /**
   * Runs a sub-agent to completion. Core owns model, API key, and shell.
   * Extensions provide system prompt, tool names, skill names, etc.
   */
  runAgentFn: (job: QueueJob<unknown>, opts: RunAgentOptions) => Promise<AgentProcessorResult>;
  /** Lookup function for core (non-extension) managed queues by name. */
  getCoreQueueFn?: (name: CoreQueueName) => ManagedQueuePort | undefined;
  /** Returns all extension-registered queues. Called lazily since queues may be added after context creation. */
  getExtensionQueuesFn?: () => ManagedQueuePort[];
  /** Shared FlowProducer instance for creating job flows/chains. */
  flowProducer: FlowProducer;
}

/** Data layer: database, sessions, and push messaging. */
export interface ExtContextData {
  /** The shared Drizzle database instance. */
  database: BunSQLiteDatabase<Record<string, unknown>>;
  /** The shared session store instance. */
  sessionStore: SessionStorePort;
  /** Programmatic push message function. */
  pushMessageFn?: PushMessageFn;
}

/** Skill resolution and management. */
export interface ExtContextSkills {
  /** Resolves a skill name to its entry. Called lazily at runtime. */
  resolveSkillFn?: (name: string) => SkillEntry | undefined;
  /** Callback to re-discover and re-load all skills from extension directories. */
  rescanSkillsFn?: () => Promise<void>;
  /** Returns skill names whose owning extension is enabled. */
  getSkillNamesFn?: () => string[];
}

/** Extension lifecycle and hot-loading. */
export interface ExtContextLifecycle {
  /** Checks whether the given extension is enabled. */
  isExtensionEnabledFn: (name: string) => boolean;
  /** Look up a registered step type handler by type name. */
  getStepHandlerFn?: (type: string) => import("./types").StepTypeHandler | undefined;
  /** Callback to load an extension at runtime. */
  loadOneFn?: (modulePath: string) => Promise<boolean>;
  /** Callback to unload an extension at runtime. */
  unloadOneFn?: (name: string) => Promise<boolean>;
  /** Set of built-in extension names (cannot be unloaded). */
  builtinExtensionNames?: ReadonlySet<string>;
}

/** Full dependency set for creating an extension context. */
export interface ExtensionContextDeps
  extends ExtContextIdentity,
    ExtContextRegistration,
    ExtContextEvents,
    ExtContextAgent,
    ExtContextData,
    ExtContextSkills,
    ExtContextLifecycle {
  /** The SQLite-backed encrypted secret vault (optional - replaces secretStore for extension secrets). */
  secretVault?: SecretVault;
  /** The extension's settingsSchema (TypeBox TObject), if declared. */
  settingsSchema?: Record<string, unknown>;
}

/**
 * Creates an `ExtensionContext` for a single extension. All registrations
 * are tracked in the returned `LoadedExtension` record so the registry
 * can aggregate and clean up later.
 *
 * @param deps The dependencies to wire into the context
 * @returns The extension context and loaded extension metadata
 */
export function createExtensionContext(deps: ExtensionContextDeps): {
  context: ExtensionContext;
  loaded: Omit<LoadedExtension, "extension">;
} {
  const {
    extensionName,
    workDir,
    dataDir,
    extensionsDir,
    toolNameSet,
    routeKeySet,
    eventBus,
    broadcastFn,
    flowProducer,
    resolveSkillFn,
    database,
    getCoreQueueFn,
    getExtensionQueuesFn,
    runAgentFn,
    sessionStore,
    pushMessageFn,
    isExtensionEnabledFn,
    secretVault,
    rescanSkillsFn,
    getSkillNamesFn,
    loadOneFn,
    unloadOneFn,
    externalExtensionsDir,
    builtinExtensionNames,
    settingsSchema,
    routeRegistry,
    stepTypeNameSet,
    getStepHandlerFn,
  } = deps;

  const tools: AgentTool[] = [];
  const routes: RegisteredRoute[] = [];
  const queues: ManagedQueuePort[] = [];
  const stepTypes: RegisteredStepType[] = [];

  // -------------------------------------------------------------------------
  // Settings cache - holds parsed config JSON from SQLite in memory.
  // Invalidated when a `settings:changed` event fires for this extension.
  // -------------------------------------------------------------------------

  /** Cached settings object from SQLite (null = not yet loaded). */
  let settingsCache: Record<string, unknown> | null = null;

  /**
   * Load persisted settings from SQLite into the cache.
   * Returns the cached object (may be empty `{}`).
   */
  function loadSettingsCache(): Record<string, unknown> {
    if (settingsCache !== null) return settingsCache;
    try {
      const row = database
        .select({ config: schema.extensionSettings.config })
        .from(schema.extensionSettings)
        .where(eq(schema.extensionSettings.name, extensionName))
        .get();
      settingsCache = row?.config ? (JSON.parse(row.config) as Record<string, unknown>) : {};
    } catch {
      settingsCache = {};
    }
    return settingsCache;
  }

  /** Invalidate the settings cache so the next read fetches from SQLite. */
  function invalidateSettingsCache(): void {
    settingsCache = null;
  }

  /**
   * Convert an UPPER_SNAKE_CASE key (e.g. "MAX_PAYLOAD_SIZE") to camelCase
   * (e.g. "maxPayloadSize") for matching against schema property names.
   */
  function envKeyToCamelCase(key: string): string {
    return key.toLowerCase().replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  }

  /**
   * Register an agent tool with the system.
   * Tools must have unique names within the global tool namespace.
   *
   * @param tool The tool to register
   * @throws If the tool name is already registered
   */
  function registerTool(tool: AgentTool): void {
    if (toolNameSet.has(tool.name)) {
      const msg = `Extension "${extensionName}": tool name "${tool.name}" conflicts with an existing tool`;
      logger.error(msg);
      throw new Error(msg);
    }
    toolNameSet.add(tool.name);
    tools.push(tool);
    logger.debug(`Extension "${extensionName}" registered tool "${tool.name}"`);
  }

  /**
   * Returns all registered tool names from the global tool name set.
   *
   * @returns Array of tool names
   */
  function getToolNames(): string[] {
    return [...toolNameSet];
  }

  /**
   * Returns skill names whose owning extension is enabled.
   *
   * @returns Array of skill names
   */
  function getSkillNames(): string[] {
    return getSkillNamesFn?.() ?? [];
  }

  /**
   * Register an HTTP route handler for this extension.
   * The full path will be prefixed with "/ext/{extensionName}/"
   *
   * @param method The HTTP method to handle
   * @param path The path to handle (leading slash optional)
   * @param handler The route handler function
   * @throws If the route path is already registered
   */
  function registerRoute(method: HttpMethod, path: string, handler: RouteHandler): void {
    const cleanPath = path.replace(/^\/+/, "");
    const fullPath = `/ext/${extensionName}/${cleanPath}`;
    const routeKey = `${method}:${fullPath}`;

    if (routeKeySet.has(routeKey)) {
      const msg = `Extension "${extensionName}": duplicate route ${method} ${fullPath}`;
      logger.error(msg);
      throw new Error(msg);
    }

    routeKeySet.add(routeKey);
    routes.push({ method, fullPath, handler });
    logger.debug(`Extension "${extensionName}" registered route ${method} ${fullPath}`);

    // Wire directly into the HTTP server
    if (routeRegistry) {
      routeRegistry.registerRoute(method, fullPath, handler);
    }
  }

  /**
   * Create a new queue with the given name and processor.
   * The queue will be automatically started and stopped with the agent.
   *
   * @param name The name of the queue
   * @param processor The processor function to handle jobs
   * @param opts Options to configure the queue
   * @returns The queue instance
   */
  function createQueue<T = unknown, R = unknown>(
    name: string,
    processor: JobProcessor<T, R>,
    opts?: ManagedQueueOptions,
  ): ManagedQueuePort<T> {
    const prefixedName = `${extensionName}:${name}`;
    const mq = new ManagedQueue<T, R>(prefixedName, processor, opts);
    queues.push(mq as ManagedQueuePort);
    logger.debug(`Extension "${extensionName}" created queue "${prefixedName}"`);
    return mq;
  }

  /**
   * Register a custom workflow step type handler.
   * Step type names must be globally unique (no two extensions can register the same type).
   *
   * @param type The step type identifier
   * @param handler The handler implementing validation and execution
   * @throws If the type name conflicts with a built-in or already-registered type
   */
  function registerStepType(type: string, handler: StepTypeHandler): void {
    const reserved = new Set(["agent", "webhook"]);
    if (reserved.has(type)) {
      const msg = `Extension "${extensionName}": step type "${type}" is a built-in type and cannot be overridden`;
      logger.error(msg);
      throw new Error(msg);
    }
    if (stepTypeNameSet.has(type)) {
      const msg = `Extension "${extensionName}": step type "${type}" conflicts with an already-registered type`;
      logger.error(msg);
      throw new Error(msg);
    }
    stepTypeNameSet.add(type);
    stepTypes.push({ type, handler, extensionName });
    logger.debug(`Extension "${extensionName}" registered step type "${type}"`);
  }

  /**
   * Look up a registered custom step type handler by type name.
   * Delegates to the registry-provided lookup function.
   *
   * @param type The step type identifier to look up
   * @returns The handler, or undefined if not found
   */
  function getStepHandler(type: string): StepTypeHandler | undefined {
    return getStepHandlerFn?.(type);
  }

  /**
   * Subscribe to agent events emitted on the event bus.
   *
   * @param eventType The event type to listen for
   * @param callback The callback to invoke
   */
  function on(eventType: EventType, callback: EventCallback | ((event: any) => void | Promise<void>)): void {
    eventBus.subscribe(extensionName, eventType, callback as EventCallback);
  }

  /**
   * Emit a domain event onto the shared event bus.
   *
   * @param event - The event to dispatch to all subscribers
   */
  function emitEvent(event: EventParam): void {
    eventBus.dispatch(event);
  }

  /**
   * Read a configuration value for this extension by key.
   * Precedence: env var > SQLite persisted value > schema default > caller default.
   *
   * Values are coerced from the raw env-var string:
   * `"true"`/`"false"` -> boolean, numeric strings -> number,
   * JSON-shaped strings -> parsed object/array, everything else -> string.
   *
   * @param key - The configuration key (UPPER_SNAKE_CASE).
   * @param defaultValue - Returned when no source provides a value.
   * @returns The resolved value, or `undefined`.
   */
  function getConfig(key: string, defaultValue?: ConfigValue): ConfigValue | undefined {
    // 1. Check environment variable (highest precedence)
    const envKey = `EXT_${extensionName.toUpperCase().replace(/-/g, "_")}_${key}`;
    const val = process.env[envKey];
    if (typeof val !== "undefined") {
      return coerceEnvValue(val, defaultValue);
    }

    // 2. Check SQLite persisted settings
    const camelKey = envKeyToCamelCase(key);
    const cached = loadSettingsCache();
    if (camelKey in cached) {
      return cached[camelKey] as ConfigValue;
    }

    // 3. Check schema default
    if (settingsSchema) {
      const properties = (settingsSchema as Record<string, unknown>).properties as
        | Record<string, Record<string, unknown>>
        | undefined;
      if (properties?.[camelKey]?.default !== undefined) {
        return properties[camelKey].default as ConfigValue;
      }
    }

    // 4. Caller-provided default
    return defaultValue;
  }

  /**
   * Coerce a raw env-var string into a typed ConfigValue.
   */
  function coerceEnvValue(val: string, defaultValue?: ConfigValue): ConfigValue | undefined {
    try {
      if (val.toLowerCase() === "true") return true;
      if (val.toLowerCase() === "false") return false;

      const num = Number(val);
      if (!Number.isNaN(num) && val.trim() !== "") return num;

      if (val.startsWith("{") || val.startsWith("[")) {
        return JSON.parse(val) as Record<string, unknown> | unknown[];
      }
    } catch {
      return defaultValue;
    }

    return val;
  }

  /**
   * Broadcast a WebSocket message to all connected frontend clients.
   *
   * @param message - The WebSocket message to broadcast
   */
  function broadcast(message: WebSocketMessage): void {
    if (broadcastFn) {
      broadcastFn(message);
    } else {
      logger.warn(`Extension "${extensionName}" called broadcast() but no broadcast function is configured`);
    }
  }

  /**
   * Get the shared Drizzle database instance.
   *
   * @returns The shared Drizzle BunSQLiteDatabase instance
   */
  function getDatabase(): BunSQLiteDatabase<Record<string, unknown>> {
    return database;
  }

  /**
   * Submit a job to the core Agents queue.
   *
   * @param name - Job name/label
   * @param data - Job payload
   * @returns The created job ID
   */
  async function enqueueAgent(name: string, data: { context?: AgentEventContext; sessionId: string }): Promise<string> {
    const agentQueue = getCoreQueueFn?.("agents");
    if (!agentQueue) {
      throw new Error(`Extension "${extensionName}": core "agents" queue is not available`);
    }
    return agentQueue.add(name, data);
  }

  /**
   * Resolve a queue instance by name — checks core queues first, then extension queues.
   */
  function resolveQueue(queueName: string): ManagedQueuePort | undefined {
    // Try core queues first
    if (isCoreQueueName(queueName)) {
      return getCoreQueueFn?.(queueName);
    }
    // Try extension queues
    if (getExtensionQueuesFn) {
      return getExtensionQueuesFn().find((q) => q.name === queueName);
    }
    return undefined;
  }

  /** Type guard for core queue names. */
  function isCoreQueueName(name: string): name is CoreQueueName {
    return name === "agents" || name === "chat";
  }

  /**
   * Subscribe to events on any queue (core or extension).
   */
  function onQueueEvent(
    queueName: string,
    event: QueueEventName,
    callback: (data: { jobId: string; failedReason?: string; job: JobInfo | null }) => void,
  ): void {
    const queue = resolveQueue(queueName);
    if (!queue) {
      logger.warn(`Extension "${extensionName}": queue "${queueName}" not found for onQueueEvent`);
      return;
    }
    queue.onEvent(event, callback);
  }

  /**
   * Unsubscribe a previously registered event handler from any queue.
   */
  function offQueueEvent(
    queueName: string,
    event: QueueEventName,
    callback: (data: { jobId: string; failedReason?: string; job: JobInfo | null }) => void,
  ): void {
    const queue = resolveQueue(queueName);
    if (!queue) {
      logger.warn(`Extension "${extensionName}": queue "${queueName}" not found for offQueueEvent`);
      return;
    }
    queue.offEvent(event, callback);
  }

  /**
   * Read log entries from a job on any queue.
   */
  async function getJobLogs(queueName: string, jobId: string): Promise<QueueJobLogs> {
    const queue = resolveQueue(queueName);
    if (!queue) {
      return { logs: [], count: 0 };
    }
    return queue.getJobLogs(jobId);
  }

  /**
   * Get the shared FlowProducer instance for creating job flows/chains.
   */
  function getFlowProducer(): FlowProducer {
    return flowProducer;
  }

  /**
   * Get the names of all registered queues (core + extension).
   */
  function getAllQueueNames(): string[] {
    const names: string[] = [];
    // Core queues
    const coreNames: CoreQueueName[] = ["agents", "chat"];
    for (const name of coreNames) {
      if (getCoreQueueFn?.(name)) names.push(name);
    }
    // Extension queues
    if (getExtensionQueuesFn) {
      for (const q of getExtensionQueuesFn()) {
        names.push(q.name);
      }
    }
    return names;
  }

  /**
   * Resolve a skill name to its entry.
   */
  function resolveSkill(name: string): SkillEntry | undefined {
    return resolveSkillFn?.(name);
  }

  /**
   * Trigger a full re-discovery and re-loading of all skills from extension
   * directories. Use after writing new skill files at runtime.
   */
  async function rescanSkills(): Promise<void> {
    if (!rescanSkillsFn) {
      logger.warn(`Extension "${extensionName}" called skills.rescan() but no rescan function is configured`);
      return;
    }
    await rescanSkillsFn();
  }

  /**
   * Check whether this extension (or another named extension) is currently enabled.
   *
   * @param name - Optional extension name to query. Defaults to this extension.
   * @returns `true` if the target extension is enabled (or has no explicit setting)
   */
  function isEnabled(name?: string): boolean {
    return isExtensionEnabledFn(name ?? extensionName);
  }

  /**
   * Retrieve a secret value with scoped consumer identity.
   * Resolves exclusively from the SQLite-backed SecretVault when available.
   * Returns null with a warning when the vault is not configured.
   */
  async function getSecret(key: string): Promise<string | null> {
    if (!secretVault) {
      logger.warn(`Extension "${extensionName}" called getSecret() but vault is not configured`);
      return null;
    }
    const result = await secretVault.resolve(extensionName, key, `ext:${extensionName}`);
    return result.value;
  }

  /**
   * Resolve a secret by key across all scopes using a custom consumer identity.
   * Used by trusted core extensions (e.g. workflows) that resolve secrets
   * on behalf of other entities (e.g. workflow:{name}).
   * Returns null with a warning when the vault is not configured.
   */
  async function resolveSecretAs(key: string, consumer: string): Promise<string | null> {
    if (!secretVault) {
      logger.warn(`Extension "${extensionName}" called resolveAs() but vault is not configured`);
      return null;
    }
    const result = await secretVault.resolveByKey(key, consumer);
    return result.value;
  }

  /**
   * Store a secret value with scoped consumer identity.
   * Writes to the SQLite-backed SecretVault when available.
   * Rejects the operation when the vault is not configured.
   */
  async function setSecret(key: string, value: string, opts?: SetSecretOptions): Promise<void> {
    if (!secretVault) {
      logger.warn(`Extension "${extensionName}" called setSecret() but vault is not configured`);
      throw new Error("Web secret storage is not available (no master key configured)");
    }
    await secretVault.bulkUpsert(extensionName, { [key]: value }, opts?.consumers);
  }

  /**
   * Load and activate an external extension at runtime.
   * Path must be within the external extensions directory.
   *
   * @param modulePath - Absolute path to the extension's index.ts
   * @returns `true` on success, `false` on failure
   */
  async function loadExtension(modulePath: string): Promise<boolean> {
    if (!loadOneFn) {
      logger.warn(`Extension "${extensionName}" called loadExtension() but hot-loading is not available`);
      return false;
    }
    // Path validation: must be within the external extensions directory
    if (externalExtensionsDir && !modulePath.startsWith(externalExtensionsDir)) {
      logger.error(
        `Extension "${extensionName}" attempted to load from outside external extensions dir: ${modulePath}`,
      );
      return false;
    }
    return loadOneFn(modulePath);
  }

  /**
   * Unload and deactivate an extension at runtime.
   * Built-in extensions cannot be unloaded.
   *
   * @param name - The extension manifest name to unload
   * @returns `true` on success, `false` on failure
   */
  async function unloadExtension(name: string): Promise<boolean> {
    if (!unloadOneFn) {
      logger.warn(`Extension "${extensionName}" called unloadExtension() but hot-loading is not available`);
      return false;
    }
    // Cannot unload built-in extensions
    if (builtinExtensionNames?.has(name)) {
      logger.error(`Extension "${extensionName}" attempted to unload built-in extension "${name}"`);
      return false;
    }
    return unloadOneFn(name);
  }

  /** Scoped logger for this extension. */
  const log = createLogger(`ext:${extensionName}`);

  // Subscribe to settings:changed events to invalidate the cache
  eventBus.subscribe(extensionName, "settings:changed", (event) => {
    if ("extensionName" in event && event.extensionName === extensionName) {
      invalidateSettingsCache();
    }
  });

  const context: ExtensionContext = {
    log,
    workDir,
    dataDir,
    extensionsDir,
    fetch: authenticatedFetch,
    registerTool,
    getToolNames,
    registerRoute,
    createQueue,
    registerStepType,
    getStepHandler,
    on,
    emitEvent,
    broadcast,
    registerDynamicItemProvider: registerProviderFn,
    getConfig,
    getDatabase,
    isEnabled,
    runAgent: runAgentFn,
    enqueueAgent,
    sessions: sessionStore,
    pushMessage: pushMessageFn
      ? pushMessageFn
      : () => {
          throw new Error(`Extension "${extensionName}": pushMessage is not available`);
        },
    queues: {
      onEvent: onQueueEvent,
      offEvent: offQueueEvent,
      getJobLogs,
      getFlowProducer,
      getAllQueueNames,
    },
    secrets: {
      get: getSecret,
      set: setSecret,
      resolveAs: resolveSecretAs,
    },
    skills: {
      resolve: resolveSkill,
      getNames: getSkillNames,
      rescan: rescanSkills,
    },
    loadExtension,
    unloadExtension,
  };

  return { context, loaded: { tools, routes, queues, stepTypes, state: "active" as const } };
}
