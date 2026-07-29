/**
 * Extension system public API - the types extension authors interact with.
 *
 * Internal types used by the registry and context factory live in
 * `internalTypes.ts` and should not be imported by extensions.
 */

import type { AgentEvent, AgentMessage, AgentTool, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { WebSocketMessage } from "@shared/types";
import { type Static, type TObject, type TSchema, Type } from "@sinclair/typebox";
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
// Custom workflow step types
// ---------------------------------------------------------------------------

/**
 * Context passed to a custom step type handler during execution.
 * Provides template resolution, logging, and filesystem access.
 */
export interface StepExecutionContext {
  /**
   * Resolve `{{...}}` template expressions in a string using the workflow's
   * template context (trigger payload, previous step results, env vars, secrets, step configs).
   *
   * @param template - The template string with `{{...}}` expressions
   * @returns The resolved string and any resolution warnings
   */
  resolveTemplate(template: string): Promise<{ resolved: string; warnings: string[] }>;

  /** Logger scoped to the current step execution. */
  readonly log: Logger;

  /** Absolute path to the agent's working directory. */
  readonly workDir: string;

  /**
   * Log a message to the job's persistent log (visible in the web UI).
   *
   * @param message - The message to log
   */
  jobLog(message: string): Promise<void>;
}

/**
 * Result of a pre-transition input validation check performed by the
 * succeeding step's handler before the preceding step completes.
 *
 * When validation fails, the diagnostics are fed back to the producing agent
 * as a repair prompt, giving it a chance to self-correct before the workflow
 * advances.
 */
export interface StepInputValidation {
  /** Whether the output is acceptable for the next step. */
  valid: boolean;
  /**
   * Diagnostic messages explaining what's wrong. Fed back to the producing
   * agent as repair instructions when `valid` is `false`.
   */
  diagnostics?: string[];
}

/**
 * Handler for a custom workflow step type registered by an extension.
 *
 * Extensions call {@link ExtensionContext.registerStepType} during initialization
 * to make a new step type available in workflow definitions. The workflow engine
 * dispatches to the handler when a step with the matching type is encountered.
 */
export interface StepTypeHandler {
  /** TypeBox schema for validating the step definition (excluding `slug` and `type`). */
  schema: TObject;

  /** Human-readable label for the step type (shown in UI dropdowns and graph nodes). */
  label: string;

  /** Optional emoji or icon identifier for graph node rendering. */
  icon?: string;

  /**
   * Optional TypeBox schema describing the expected shape of input data from
   * the preceding step. Used by the workflow engine to validate the preceding
   * step's output BEFORE the transition occurs, enabling agent self-repair.
   *
   * When provided, the engine uses `Value.Check()` against this schema and
   * formats `Value.Errors()` into diagnostics that are fed back to the
   * producing agent for repair.
   */
  inputSchema?: TSchema;

  /**
   * Validate that data produced by the preceding step conforms to semantic
   * expectations of this step.
   *
   * Called by the workflow engine BEFORE the preceding step completes, giving
   * the producing step (typically an agent) a chance to repair its output.
   * Only invoked when the preceding step is an agent step.
   *
   * The default validation (when this method is not provided) uses
   * {@link inputSchema} with TypeBox `Value.Check` / `Value.Errors`.
   * Override this method for domain-specific checks beyond structural
   * validation (e.g. verifying column keys match the step config).
   *
   * @param output - The raw output from the preceding step
   * @param stepDef - This step's definition (for checking config-specific invariants)
   * @returns Validation result with diagnostics on failure
   */
  validateInput?(output: unknown, stepDef: Record<string, unknown>): StepInputValidation | Promise<StepInputValidation>;

  /**
   * Execute the custom step logic.
   *
   * @param stepDef - The full step definition object from the workflow JSON5
   * @param ctx - Execution context with template resolution, logging, and workDir access
   * @returns The step result value (passed to subsequent steps via `{{steps.<slug>.result}}`)
   */
  execute(stepDef: Record<string, unknown>, ctx: StepExecutionContext): Promise<unknown>;
}

/**
 * Metadata about a registered custom step type, surfaced to the frontend
 * for workflow editor UI rendering.
 */
export interface StepTypeInfo {
  /** The step type identifier (e.g. "excel"). */
  type: string;
  /** Human-readable label (e.g. "Excel Writer"). */
  label: string;
  /** Optional emoji or icon identifier. */
  icon?: string;
  /** Name of the extension that registered this step type. */
  extensionName: string;
}

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
// Queue event callback
// ---------------------------------------------------------------------------

/** Callback type for queue event subscriptions. */
export type QueueEventCallback = (data: { jobId: string; failedReason?: string; job: JobInfo | null }) => void;

// ---------------------------------------------------------------------------
// ExtensionContext
// ---------------------------------------------------------------------------

/** Scoped interface an extension receives during {@link Extension.initialize}. */
export interface ExtensionContext {
  /** Pre-scoped logger for this extension (named `ext:{extensionName}`). */
  readonly log: Logger;

  /** Filesystem paths relevant to extension operation. */
  readonly paths: {
    /** Absolute path to the agent's working directory. */
    readonly work: string;
    /** Absolute path to the data directory (databases, generated content). */
    readonly data: string;
    /** Absolute path to the extensions directory. */
    readonly extensions: string;
  };

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  /** Agent tool registration and discovery. */
  readonly tools: {
    /** Register an additional agent tool. */
    register(tool: AgentTool): void;
    /**
     * Returns all registered tool names (core + extensions) from enabled extensions.
     * The list is not sorted - callers should sort if needed.
     */
    names(): string[];
  };

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  /** HTTP route registration (path auto-prefixed with `/ext/{extensionName}/`). */
  readonly routes: {
    register(method: HttpMethod, path: string, handler: RouteHandler): void;
  };

  // -------------------------------------------------------------------------
  // Queues
  // -------------------------------------------------------------------------

  /** Job queue management, introspection, and event subscription. */
  readonly queues: {
    /**
     * Create a managed job queue with scheduling support.
     * Name is auto-prefixed with `{extensionName}:`.
     *
     * @param name - Queue name (will be prefixed)
     * @param processor - Function that processes each job
     * @param opts - Optional queue/worker configuration
     * @returns A managed queue instance
     */
    create<T = unknown, R = unknown>(
      name: string,
      processor: JobProcessor<T, R>,
      opts?: ManagedQueueOptions,
    ): ManagedQueuePort<T>;

    /**
     * Get the names of all registered queues (core + extension).
     * Core queues are returned as-is ("agents", "chat"). Extension queues
     * are returned with their full prefixed name ("extensionName:queueSuffix").
     */
    names(): string[];

    /**
     * Subscribe to events on a queue.
     * Accepts both core queue names (`"agents"`, `"chat"`) and full extension
     * queue names (e.g. `"converter:jobs"`).
     */
    onEvent(queueName: string, event: QueueEventName, callback: QueueEventCallback): void;

    /**
     * Unsubscribe a previously registered event handler from a queue.
     * Accepts both core queue names (`"agents"`, `"chat"`) and full extension
     * queue names (e.g. `"converter:jobs"`).
     */
    offEvent(queueName: string, event: QueueEventName, callback: QueueEventCallback): void;

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
  };

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  /** Event bus for subscribing to and emitting lifecycle/domain events. */
  readonly events: {
    /** Subscribe to a typed event on the shared event bus (provides narrowed payload). */
    on<K extends keyof EventMap>(type: K, callback: (event: EventMap[K]) => void | Promise<void>): void;
    /** Subscribe to an event on the shared event bus. */
    on(type: EventType, callback: EventCallback): void;

    /** Emit a domain event onto the shared event bus. */
    emit(event: EventParam): void;
  };

  // -------------------------------------------------------------------------
  // Config
  // -------------------------------------------------------------------------

  /** Extension configuration (env vars, persisted settings, schema defaults). */
  readonly config: {
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
    get<T extends ConfigValue = ConfigValue>(key: string, defaultValue: T): T;
    get(key: string): ConfigValue | undefined;
  };

  // -------------------------------------------------------------------------
  // Secrets
  // -------------------------------------------------------------------------

  /** Encrypted secrets management with scoped ACL and audit logging. */
  readonly secrets: {
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
  };

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  /**
   * The shared session store for managing conversation sessions and messages.
   * Provides CRUD operations for sessions and their messages.
   */
  readonly sessions: SessionStorePort;

  // -------------------------------------------------------------------------
  // Skills
  // -------------------------------------------------------------------------

  /** Skill introspection - resolve skill entries for building shell contexts. */
  readonly skills: {
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
     */
    names(): string[];

    /**
     * Trigger a full re-discovery and re-loading of all skills from extension
     * directories. Use after writing new skill files at runtime (e.g., generated
     * MCP skills).
     */
    rescan(): Promise<void>;
  };

  // -------------------------------------------------------------------------
  // Agent
  // -------------------------------------------------------------------------

  /** Agent execution - run sub-agents and enqueue agent jobs. */
  readonly agent: {
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
    run(job: QueueJob<unknown>, opts: RunAgentOptions): Promise<AgentProcessorResult>;

    /**
     * Submit a job to the core Agents queue.
     *
     * @param name - Job name/label
     * @param data - Job payload (context, sessionId)
     * @returns The created job ID
     */
    enqueue(name: string, data: { context?: AgentEventContext; sessionId: string }): Promise<string>;
  };

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------

  /** Push messaging and WebSocket broadcasting. */
  readonly messaging: {
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
    push(sessionId: string, content: string, options?: PushMessageOptions): PushMessageResult;

    /** Broadcast a WebSocket message to all connected frontend clients. */
    broadcast(message: WebSocketMessage): void;
  };

  // -------------------------------------------------------------------------
  // Database
  // -------------------------------------------------------------------------

  /**
   * The shared Drizzle database instance.
   * Extensions define their own table schemas (prefixed with `ext_{extensionName}_`)
   * and query them using this instance.
   */
  readonly db: BunSQLiteDatabase<Record<string, unknown>>;

  // -------------------------------------------------------------------------
  // Fetch
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
  // State
  // -------------------------------------------------------------------------

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
  // Step types (workflow integration)
  // -------------------------------------------------------------------------

  /** Custom workflow step type registration and lookup. */
  readonly stepTypes: {
    /**
     * Register a custom workflow step type handler.
     * Step type names must be globally unique across all extensions.
     *
     * @param type - The step type identifier (e.g. "excel")
     * @param handler - The handler implementing validation and execution logic
     * @throws If the type name is already registered
     */
    register(type: string, handler: StepTypeHandler): void;

    /**
     * Look up a registered custom step type handler by type name.
     * Returns `undefined` if no handler is registered.
     *
     * @param type - The step type identifier to look up
     */
    get(type: string): StepTypeHandler | undefined;
  };

  // -------------------------------------------------------------------------
  // Dynamic items (settings UI)
  // -------------------------------------------------------------------------

  /** Dynamic item providers for settings schema enrichment. */
  readonly dynamicItems: {
    /**
     * Register a named dynamic item provider.
     *
     * When an extension's settings schema declares `dynamicItems: "<name>"` on an
     * array property, the named provider is invoked at request time to populate
     * `availableItems` dynamically.
     *
     * @param name - Unique provider name referenced by `dynamicItems` in schemas
     * @param fn - Function that returns the current available items
     */
    register(name: string, fn: () => string[]): void;
  };

  // -------------------------------------------------------------------------
  // Internal (privileged, core extensions only)
  // -------------------------------------------------------------------------

  /**
   * Privileged capabilities only available to core extensions.
   * `undefined` for regular extensions.
   */
  readonly internal?: {
    /** Secrets resolution with custom consumer identity (e.g. for workflow templates). */
    secrets: {
      /**
       * Resolve a secret by key across all scopes using a custom consumer identity.
       *
       * @param key - The secret key name to search for across all scopes
       * @param consumer - The consumer identity to use for ACL checks (e.g. "workflow:my-wf")
       * @returns The decrypted value, or null if access is denied or key doesn't exist
       */
      resolveAs(key: string, consumer: string): Promise<string | null>;
    };
  };
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
