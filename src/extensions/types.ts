/**
 * Extension system public API - the types extension authors interact with.
 *
 * Internal types used by the registry and context factory live in
 * `internalTypes.ts` and should not be imported by extensions.
 */

import type { AgentEvent, AgentMessage, AgentTool, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { WebSocketMessage } from "@shared/types";
import { type Static, type TObject, Type } from "@sinclair/typebox";
import type { ModelIntent } from "@src/models";
import type { PushMessageOptions, PushMessageResult } from "@src/push";
import type {
  JobInfo,
  JobProcessor,
  ManagedQueueOptions,
  ManagedQueuePort,
  QueueJob,
  QueueJobLogs,
  SchedulerInfo,
} from "@src/queue";
import type { SetSecretOptions } from "@src/secrets";
import type { SessionStorePort } from "@src/session";
import type { SkillEntry } from "@src/tools/sandbox";
import type { FlowProducer } from "bunqueue/client";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { Context } from "elysia";
import type { Logger } from "logging";

export type { Logger } from "logging";

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Secrets schema
// ---------------------------------------------------------------------------

/**
 * Schema for a single secret entry definition within an extension's `secretsSchema`.
 * Defines the key name, description, whether it is required, and an optional grouping label.
 */
export const SecretSchemaEntrySchema = Type.Object({
  key: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Z][A-Z0-9_]*$" }),
  description: Type.String({ minLength: 1, maxLength: 200 }),
  required: Type.Boolean(),
  group: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })),
});

/** A single secret entry definition within an extension's `secretsSchema`. */
export type SecretSchemaEntry = Static<typeof SecretSchemaEntrySchema>;

/**
 * Schema for the full secrets schema array (max 20 entries per extension).
 */
export const SecretsSchemaSchema = Type.Array(SecretSchemaEntrySchema, { maxItems: 20 });

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/** Schema for a single navigation entry declared in an extension manifest. */
export const NavigationEntrySchema = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 50 }),
  route: Type.String({ minLength: 1, maxLength: 128, pattern: "^/" }),
  icon: Type.String({ minLength: 1, maxLength: 64 }),
  order: Type.Integer({ minimum: 0, maximum: 999 }),
  badgeKey: Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-zA-Z][a-zA-Z0-9_.:-]*$" })),
  iconColor: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
});

/** Schema for the ui field in an extension manifest. */
export const ExtensionUiSchema = Type.Object({
  navigation: Type.Array(NavigationEntrySchema, { maxItems: 10 }),
});

/** TypeBox schema for runtime validation of extension manifests. */
export const ExtensionManifestSchema = Type.Object({
  name: Type.String({ minLength: 1, pattern: "^[a-z][a-z0-9-]*$" }),
  version: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
  dependencies: Type.Optional(Type.Array(Type.String())),
  settingsSchema: Type.Optional(Type.Any()),
  secretsSchema: Type.Optional(SecretsSchemaSchema),
  core: Type.Optional(Type.Boolean()),
  ui: Type.Optional(ExtensionUiSchema),
});

/** Metadata every extension must expose. */
export type ExtensionManifest = Static<typeof ExtensionManifestSchema> & {
  /** Optional TypeBox TObject schema defining configurable settings for this extension. */
  settingsSchema?: TObject;
  /** Optional array of secret entry definitions for this extension. Max 20 entries. */
  secretsSchema?: SecretSchemaEntry[];
  /** When true, the extension is considered core infrastructure and cannot be disabled. */
  core?: boolean;
  /** Optional UI contributions (navigation entries) for the frontend sidebar. */
  ui?: Static<typeof ExtensionUiSchema>;
};

// ---------------------------------------------------------------------------
// Agent events
// ---------------------------------------------------------------------------

/** Event types originating from the pi-agent-core lifecycle. */
export type AgentLifecycleEventType =
  | "before_agent_start"
  | "agent_start"
  | "agent_end"
  | "message_start"
  | "message_end"
  | "message_update"
  | "tool_execution_start"
  | "tool_execution_end"
  | "turn_start"
  | "turn_end";

/** Event types emitted by extensions (domain events, not tied to agent lifecycle). */
export type DomainEventType =
  | "webhook:received"
  | "workflow:step_failed"
  | "filewatcher:detected"
  | "scheduler:fired"
  | "settings:changed"
  | "secrets:changed";

/** All event types the event bus can dispatch and subscribe to. */
export type EventType = AgentLifecycleEventType | DomainEventType;

/** Optional routing context attached to agent events (e.g. source extension + chat ID). */
export type AgentEventContext = ({ source: string; id: string } & Record<string, unknown>) | undefined;

/** A domain event emitted by extensions (not tied to agent lifecycle). */
export interface DomainEvent {
  type: DomainEventType;
  context?: AgentEventContext;
  [key: string]: unknown;
}

/** An agent event enriched with optional routing context, or a domain event, or a before-agent-start event. */
export type EventParam = (AgentEvent & { context?: AgentEventContext }) | DomainEvent | BeforeAgentStartEvent;

/** Callback invoked when an event fires. */
export type EventCallback = (event: EventParam) => void | Promise<void>;

/**
 * Maps event type literals to their strongly-typed event payloads.
 * Used by the overloaded {@link ExtensionContext.on} to provide type-safe callbacks.
 */
export interface EventMap {
  before_agent_start: BeforeAgentStartEvent;
  "settings:changed": SettingsChangedEvent;
  "secrets:changed": SecretsChangedEvent;
}

// ---------------------------------------------------------------------------
// Settings-changed event
// ---------------------------------------------------------------------------

/** Event dispatched when an extension's settings are updated via the API. */
export interface SettingsChangedEvent {
  type: "settings:changed";
  /** Name of the extension whose settings changed. */
  extensionName: string;
  /** The merged settings values after the update. */
  values: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Secrets-changed event
// ---------------------------------------------------------------------------

/** Event dispatched when an extension's secrets are created, updated, or deleted via the API. */
export interface SecretsChangedEvent {
  type: "secrets:changed";
  /** Name of the extension whose secrets changed. */
  extensionName: string;
  /** Keys that were created or updated. */
  updatedKeys: string[];
  /** Keys that were deleted. */
  deletedKeys: string[];
}

// ---------------------------------------------------------------------------
// Before-agent-start event
// ---------------------------------------------------------------------------

/**
 * Event dispatched before the agent begins execution.
 * Extensions can mutate `systemPrompt` and `messages` to influence the agent run.
 */
export interface BeforeAgentStartEvent {
  type: "before_agent_start";
  /** Which queue triggered this agent run. */
  queue: "agents" | "chat";
  /** The assembled system prompt - extensions may mutate this. */
  systemPrompt: string;
  /** The full conversation messages loaded from the session - extensions may mutate this array. */
  messages: AgentMessage[];
  /** Session ID for the upcoming run. */
  sessionId: string;
  /** Optional routing context (source extension, chat ID, etc.). */
  context?: AgentEventContext;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** HTTP methods supported for extension routes. */
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/** Handler for an extension-registered HTTP route. */
export type RouteHandler = (ctx: Context) => Response | Promise<Response>;

// ---------------------------------------------------------------------------
// Abstract route registration surface for wiring extension routes into the
// HTTP server. Hides Elysia internals from the extension system.
// ---------------------------------------------------------------------------

/** Minimal route registration surface for wiring extension routes into the HTTP server. */
export interface RouteRegistry {
  /** Register a single HTTP route handler for an extension. */
  registerRoute(method: HttpMethod, path: string, handler: RouteHandler): void;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Union of types that {@link ExtensionContext.getConfig} can produce
 * after auto-coercing a raw env-var string.
 */
export type ConfigValue = string | number | boolean | Record<string, unknown> | unknown[];

// ---------------------------------------------------------------------------
// Core queues
// ---------------------------------------------------------------------------

/** Names of core (non-extension) queues. */
export type CoreQueueName = "agents" | "chat";

/** Event types emitted by managed queues. */
export type QueueEventName = "active" | "completed" | "failed" | "stalled";

// ---------------------------------------------------------------------------
// Agent execution
// ---------------------------------------------------------------------------

/** Result returned by {@link ExtensionContext.runAgent}. */
export interface AgentProcessorResult {
  /** The assistant's final text response. */
  answer: string;
  /** The agent's final state snapshot. */
  state: unknown;
  /** Completion timestamp (ms). */
  timestamp: number;
}

/** Options for {@link ExtensionContext.runAgent}. */
export interface RunAgentOptions {
  /** System prompt for the agent. */
  systemPrompt: string;
  /** Tool names to make available (core resolves from registered tools). */
  tools?: string[];
  /** Skill names to mount in the agent's shell. */
  skills?: string[];
  /** Thinking level passed to the agent. */
  thinkingLevel?: ThinkingLevel;
  /** Session ID for conversation context. */
  sessionId: string;
  /**
   * Model intent hint. When provided, uses the intent-specific model
   * (if configured) instead of the global default.
   */
  intent?: ModelIntent;
  /** Callback invoked for each agent lifecycle event. */
  onAgentEvent?: (event: AgentEvent) => void;
}

// ---------------------------------------------------------------------------
// ExtensionContext
// ---------------------------------------------------------------------------

/** Scoped interface an extension receives during {@link Extension.initialize}. */
export interface ExtensionContext {
  /** Pre-scoped logger for this extension (named `ext:{extensionName}`). */
  readonly log: Logger;

  /** Absolute path to the agent's working directory. */
  readonly workDir: string;

  /** Absolute path to the data directory (databases, generated content). */
  readonly dataDir: string;

  /** Absolute path to the extensions directory. */
  readonly extensionsDir: string;

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Returns all registered tool names (core + extensions) from enabled extensions.
   * The list is not sorted - callers should sort if needed.
   *
   * @returns Array of tool names
   */
  getToolNames(): string[];

  /** Register an additional agent tool. */
  registerTool(tool: AgentTool): void;

  /** Register an HTTP route (path auto-prefixed with `/ext/{extensionName}/`). */
  registerRoute(method: HttpMethod, path: string, handler: RouteHandler): void;

  /**
   * Create a managed job queue with scheduling support.
   * Name is auto-prefixed with `{extensionName}:`.
   *
   * @param name - Queue name (will be prefixed)
   * @param processor - Function that processes each job
   * @param opts - Optional queue/worker configuration
   * @returns A managed queue instance
   */
  createQueue<T = unknown, R = unknown>(
    name: string,
    processor: JobProcessor<T, R>,
    opts?: ManagedQueueOptions,
  ): ManagedQueuePort<T>;

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  /** Subscribe to a typed event on the shared event bus (provides narrowed payload). */
  on<K extends keyof EventMap>(eventType: K, callback: (event: EventMap[K]) => void | Promise<void>): void;
  /** Subscribe to an event on the shared event bus. */
  on(eventType: EventType, callback: EventCallback): void;

  /** Emit a domain event onto the shared event bus. */
  emitEvent(event: EventParam): void;

  /** Broadcast a WebSocket message to all connected frontend clients. */
  broadcast(message: WebSocketMessage): void;

  // -------------------------------------------------------------------------
  // Settings UI
  // -------------------------------------------------------------------------

  /**
   * Register a named dynamic item provider for settings schema enrichment.
   *
   * When an extension's settings schema declares `dynamicItems: "<name>"` on an
   * array property, the named provider is invoked at request time to populate
   * `availableItems` dynamically. This allows settings dropdowns to reflect
   * runtime state (e.g. available queues, models, skills).
   *
   * @param name - Unique provider name referenced by `dynamicItems` in schemas
   * @param fn - Function that returns the current available items
   */
  registerDynamicItemProvider(name: string, fn: () => string[]): void;

  // -------------------------------------------------------------------------
  // Configuration & state
  // -------------------------------------------------------------------------

  /**
   * Read a configuration value for this extension.
   *
   * Precedence: env var > SQLite persisted value > schema default > caller default.
   *
   * The raw string is auto-coerced: `"true"`/`"false"` -> boolean,
   * numeric strings -> number, JSON-shaped strings -> parsed object/array.
   * Everything else is returned as-is (string).
   *
   * @typeParam T - Expected return type (narrows the union for convenience).
   * @param key - The configuration key (UPPER_SNAKE_CASE).
   * @param defaultValue - Returned when no source provides a value.
   * @returns The resolved value, or `undefined`.
   */
  getConfig<T extends ConfigValue = ConfigValue>(key: string, defaultValue: T): T;
  getConfig(key: string): ConfigValue | undefined;

  /**
   * Get the shared Drizzle database instance.
   * Extensions define their own table schemas (prefixed with `ext_{extensionName}_`)
   * and query them using this instance.
   *
   * @returns The shared Drizzle BunSQLiteDatabase instance
   */
  getDatabase(): BunSQLiteDatabase<Record<string, unknown>>;

  /**
   * Check whether this extension is currently enabled.
   *
   * @returns `true` if the extension is enabled (or has no explicit setting)
   */
  isEnabled(): boolean;
  /**
   * Check whether another extension is currently enabled.
   *
   * @param extensionName - The name of the extension to query
   * @returns `true` if the target extension is enabled (or has no explicit setting)
   */
  isEnabled(extensionName: string): boolean;

  // -------------------------------------------------------------------------
  // Agent execution
  // -------------------------------------------------------------------------

  /**
   * Run a sub-agent to completion.
   * The core owns model selection, API key injection, and shell creation.
   * Messages are loaded from the session (via `opts.sessionId`).
   * Callers must append the user message to the session before invoking.
   *
   * @param job - The queue job (used for logging)
   * @param opts - Agent configuration (system prompt, tools, skills, sessionId, etc.)
   * @returns The agent's response
   */
  runAgent(job: QueueJob<unknown>, opts: RunAgentOptions): Promise<AgentProcessorResult>;

  /**
   * Submit a job to the core Agents queue.
   *
   * @param name - Job name/label
   * @param data - Job payload (context, sessionId)
   * @returns The created job ID
   */
  enqueueAgent(name: string, data: { context?: AgentEventContext; sessionId: string }): Promise<string>;

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  /**
   * The shared session store for managing conversation sessions and messages.
   * Provides CRUD operations for sessions and their messages.
   */
  readonly sessions: SessionStorePort;

  // -------------------------------------------------------------------------
  // Push messaging
  // -------------------------------------------------------------------------

  /**
   * Send a push message to a session. The message is appended to session
   * history and, if an active chat job exists for the session, broadcast
   * to the frontend via WebSocket.
   *
   * @param sessionId - Target session ID
   * @param content - Message content (text or markdown)
   * @param options - Optional configuration (contentType defaults to "text/markdown")
   * @returns Result indicating whether the message was broadcast or stored
   * @throws {Error} If the session does not exist
   */
  pushMessage(sessionId: string, content: string, options?: PushMessageOptions): PushMessageResult;

  // -------------------------------------------------------------------------
  // Sub-interfaces
  // -------------------------------------------------------------------------

  /** Queue introspection - subscribe to core queue events, read job logs, create flows. */
  readonly queues: QueueContext;

  /** Secrets management - read/write encrypted secrets with scoped ACL. */
  readonly secrets: SecretsContext;

  /** Skill introspection - resolve skill entries for building shell contexts. */
  readonly skills: SkillsContext;

  // -------------------------------------------------------------------------
  // Extension lifecycle (hot-load/unload)
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Internal HTTP
  // -------------------------------------------------------------------------

  /**
   * Authenticated fetch wrapper for internal API calls.
   * Automatically injects the `Authorization` header for requests targeting
   * the local server origin. Requests to external URLs pass through unmodified.
   *
   * Use this instead of the global `fetch()` when calling sibling extension
   * routes or other internal endpoints.
   */
  readonly fetch: typeof globalThis.fetch;

  // -------------------------------------------------------------------------
  // Extension lifecycle (hot-load/unload)
  // -------------------------------------------------------------------------

  /**
   * Load and activate an external extension at runtime without restarting.
   * The module path must be within the external extensions directory.
   *
   * @param modulePath - Absolute path to the extension's index.ts
   * @returns `true` on success, `false` on failure (logged)
   */
  loadExtension(modulePath: string): Promise<boolean>;

  /**
   * Unload and deactivate an extension at runtime without restarting.
   * Built-in extensions cannot be unloaded.
   *
   * @param name - The extension manifest name to unload
   * @returns `true` on success, `false` on failure (logged)
   */
  unloadExtension(name: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Sub-interfaces
// ---------------------------------------------------------------------------

/** Queue introspection capabilities. */
export interface QueueContext {
  /**
   * Subscribe to events on a queue.
   *
   * Accepts both core queue names (`"agents"`, `"chat"`) and full extension
   * queue names (e.g. `"converter:jobs"`).
   *
   * @param queueName - Queue name (core or extension-prefixed)
   * @param event - Event type to listen for
   * @param callback - Callback invoked when the event fires (includes the resolved job)
   */
  onEvent(
    queueName: string,
    event: QueueEventName,
    callback: (data: { jobId: string; failedReason?: string; job: JobInfo | null }) => void,
  ): void;

  /**
   * Unsubscribe a previously registered event handler from a queue.
   *
   * Accepts both core queue names (`"agents"`, `"chat"`) and full extension
   * queue names (e.g. `"converter:jobs"`).
   *
   * @param queueName - Queue name (core or extension-prefixed)
   * @param event - Event type to unsubscribe from
   * @param callback - The exact handler reference passed to {@link onEvent}
   */
  offEvent(
    queueName: string,
    event: QueueEventName,
    callback: (data: { jobId: string; failedReason?: string; job: JobInfo | null }) => void,
  ): void;

  /**
   * Read log entries from a job on any queue.
   *
   * @param queueName - Queue name (core or extension-prefixed)
   * @param jobId - The job ID to read logs for
   * @returns The job's log entries and count
   */
  getJobLogs(queueName: string, jobId: string): Promise<QueueJobLogs>;

  /**
   * Get the shared {@link FlowProducer} instance for creating job flows/chains.
   *
   * @returns The shared FlowProducer (embedded mode)
   */
  getFlowProducer(): FlowProducer;

  /**
   * Get the names of all registered queues (core + extension).
   *
   * Core queues are returned as-is ("agents", "chat"). Extension queues
   * are returned with their full prefixed name ("extensionName:queueSuffix").
   *
   * @returns Array of all queue names currently registered in the system
   */
  getAllQueueNames(): string[];
}

/** Secrets management capabilities. */
export interface SecretsContext {
  /**
   * Retrieve a secret value. Access is controlled by the secrets ACL and
   * all access attempts are audited. The consumer identity is automatically
   * set to this extension's name.
   *
   * @param key - The secret key name
   * @returns The decrypted value, or null if access is denied or key doesn't exist
   */
  get(key: string): Promise<string | null>;

  /**
   * Store a secret value (encrypted). Optionally configure which consumers
   * may access it. The consumer identity is automatically set to this extension.
   *
   * @param key - The secret key name
   * @param value - The plaintext value to encrypt and store
   * @param opts - Optional ACL configuration for the new secret
   */
  set(key: string, value: string, opts?: SetSecretOptions): Promise<void>;

  /**
   * Resolve a secret by key across all scopes using a custom consumer identity.
   *
   * Used by trusted core code (e.g. workflow templates) that needs to resolve
   * secrets with a different consumer identity than the extension's own
   * `ext:{name}` pattern. Searches all scopes for the key and checks ACL
   * with the provided consumer identity.
   *
   * @param key - The secret key name to search for across all scopes
   * @param consumer - The consumer identity to use for ACL checks (e.g. "workflow:my-wf")
   * @returns The decrypted value, or null if access is denied or key doesn't exist
   */
  resolveAs?(key: string, consumer: string): Promise<string | null>;
}

/** Skill introspection capabilities. */
export interface SkillsContext {
  /**
   * Resolve a skill name to its entry (directory path, frontmatter, etc.).
   *
   * @param name - The skill name to look up
   * @returns The skill entry, or undefined if not found
   */
  resolve(name: string): SkillEntry | undefined;

  /**
   * Returns the names of all skills whose owning extension is enabled.
   * The list is not sorted - callers should sort if needed.
   *
   * @returns Array of skill names from enabled extensions
   */
  getNames(): string[];

  /**
   * Trigger a full re-discovery and re-loading of all skills from extension
   * directories. Use after writing new skill files at runtime (e.g., generated
   * MCP skills).
   *
   * Fires the `onSkillMapChanged` callback if the skill map changes.
   */
  rescan(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/** Contract every extension default-export must implement. */
export interface Extension {
  /** Extension metadata (name, version, dependencies). */
  manifest: ExtensionManifest;
  /** Called once during startup with a scoped context for registering capabilities. */
  initialize(context: ExtensionContext): Promise<void>;
  /** Called during shutdown - clean up resources (connections, timers, etc.). */
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Re-exported queue types for extension use
// ---------------------------------------------------------------------------

export type { JobProcessor, ManagedQueueOptions, ManagedQueuePort, QueueJob, QueueJobLogs, SchedulerInfo };

// ---------------------------------------------------------------------------
// Skill script context
// ---------------------------------------------------------------------------

/**
 * Context passed to a skill script's `registerSkill` function by the
 * extension registry. Provides pre-built URLs so scripts never need to
 * import host/port configuration directly.
 */
export interface SkillScriptContext {
  /** Fully-qualified base URL for this extension's routes (e.g. `http://localhost:3000/ext/introspection`). */
  baseUrl: string;
  /** Server origin without a trailing slash (e.g. `http://localhost:3000`). */
  serverUrl: string;
  /** Absolute path to the extensions directory. */
  extensionsDir: string;
  /**
   * Authenticated fetch wrapper. Automatically injects the `Authorization`
   * header for requests targeting the local server origin. Use this instead
   * of the global `fetch()` for internal API calls.
   *
   * Requests to external URLs pass through without modification.
   */
  fetch: typeof globalThis.fetch;
  /**
   * Registers a shell program in the sandbox so the agent can invoke it by name.
   * Provided by the loader - scripts should use this instead of importing from the SDK.
   *
   * @param name - Program name (bare name or absolute path)
   * @param callback - The program handler
   * @param skillName - The skill this program belongs to
   */
  registerProgram: (
    name: string,
    callback: (args: string[], ctx: import("just-bash").CommandContext) => Promise<import("just-bash").ExecResult>,
    skillName: string,
  ) => void;
}
