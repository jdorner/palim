/**
 * AppBootstrap - Orchestrates the full application startup sequence.
 *
 * Separates *construction* (what to create) from *lifecycle* (when to start).
 * This eliminates the god-object pattern in main.ts and makes startup
 * explicit, testable, and self-documenting.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import type { WebSocketMessage } from "@shared/types";
import { DATA_DIR, EXTENSIONS_DIR, EXTERNAL_EXTENSIONS_DIR, WEB_HOST, WEB_PORT, WORK_DIR } from "@src/config";
import { appConfig, closeDb, getDb } from "@src/db";
import type {
  CoreQueueName,
  HttpMethod,
  RegistryInitDeps,
  RouteHandler,
  RouteRegistry,
  RunAgentOptions,
} from "@src/extensions";
import { ExtensionRegistry } from "@src/extensions";
import type { EventBus } from "@src/extensions/eventBus";
import type { AgentJob, AgentProcessorConfig, AgentProcessorResult, ChatJob } from "@src/jobs";
import { runAgent as coreRunAgent } from "@src/jobs";
import { buildModelConfig, detectAndSetProvider, fetchAvailableModels, getModelForIntent } from "@src/models";
import type { ManagedQueuePort, QueueJob } from "@src/queue";
import { closeLogStore, startLogPurgeTimer } from "@src/queue";
import { SecretVault } from "@src/secrets/vault";
import { getSessionStore } from "@src/session";
import { SANDBOX_TOOL_NAMES } from "@src/tools/file";
import type { SkillEntry } from "@src/tools/sandbox";
import { createShell } from "@src/tools/sandbox";
import { isLLMConnectionError } from "@src/utils/error";
import { mainLogger as log } from "@src/utils/logger";
import { mapAgentEventToChatEvent } from "@src/web/chatEvents";
import type { QueueMonitor } from "@src/web/monitor";
import { createWebServer, startWebServer } from "@src/web/server";
import { registerSessionChat, unregisterSessionChat } from "@src/web/sessionChatMap";
import { shutdownManager } from "bunqueue/client";
import type { AnyElysia } from "elysia";
import { createCoreQueues } from "./queueFactory";
import { deriveMasterKey } from "./secretFactory";

/**
 * Resolves the currently selected model from the database.
 * Falls back to the first available model from the endpoint if none is configured.
 */
async function getSelectedModel(): Promise<Model<"openai-completions">> {
  let modelId = appConfig.get("selected_model");
  const reasoning = appConfig.get("model_reasoning") === "true";

  // Try environment variable instead
  if (!modelId) {
    modelId = process.env.OPENAI_DEFAULT_MODEL;
  }

  if (!modelId) {
    const models = await fetchAvailableModels();

    const firstModel = models?.[0];
    if (!firstModel) {
      throw new Error("No models available from LLM endpoint");
    }
    modelId = firstModel.id;
    log.info(`No model selected, using first available: ${firstModel.id}`);
  }

  if (modelId) {
    return await buildModelConfig(modelId, reasoning);
  }

  log.warn("No model selected");
  return await buildModelConfig("", reasoning);
}

// ---------------------------------------------------------------------------
// Skill resolver helper
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tool resolver for extension tools
// ---------------------------------------------------------------------------

/** Resolves a non-sandbox tool name to its {@link AgentTool} instance. */
function createToolResolver(extensionTools: () => AgentTool[]) {
  return (name: string): AgentTool | undefined => {
    // Extension-registered tools take priority (most recently loaded)
    for (const t of extensionTools()) {
      if (t.name === name) return t;
    }
    return undefined;
  };
}

// ---------------------------------------------------------------------------
// Core job runner wrappers for extensions
// ---------------------------------------------------------------------------

function createExtensionRunAgent(
  resolveSkill: (name: string) => SkillEntry | undefined,
  getExtensionTools: () => AgentTool[],
  getApiKey: () => string,
  getEventBus: () => EventBus,
): (job: QueueJob<unknown>, opts: RunAgentOptions) => Promise<AgentProcessorResult> {
  return async (job, opts) => {
    const toolNames = opts.tools ?? [];
    if (opts.skills && !toolNames.includes("exec")) {
      toolNames.unshift("exec");
    }

    // Create a shell whenever any sandbox tool is requested, not only when skills are present.
    // Without this, tools like "exec" would be silently dropped from the LLM call.
    const needsShell = toolNames.some((name) => SANDBOX_TOOL_NAMES.has(name));

    const config: AgentProcessorConfig = {
      model: opts.intent ? (await getModelForIntent(opts.intent)).model : await getSelectedModel(),
      tools: toolNames,
      toolResolver: createToolResolver(getExtensionTools),
      apiKey: getApiKey(),
      systemPrompt: opts.systemPrompt,
      thinkingLevel: opts.thinkingLevel ?? "low",
      sessionId: opts.sessionId,
      shellFactory: needsShell
        ? (skills) => createShell({ skills, resolveSkill, sessionId: opts.sessionId })
        : undefined,
      skills: opts.skills,
      eventBus: getEventBus(),
    };

    return coreRunAgent(job, config, opts.onAgentEvent);
  };
}

// ---------------------------------------------------------------------------
// AppBootstrap class
// ---------------------------------------------------------------------------

/**
 * Orchestrates the full application startup sequence.
 *
 * Construction phase (`create()`): Builds all subsystems in dependency order.
 * Startup phase (`start()`): Wires runtime dependencies, starts extensions, listens.
 */
export class AppBootstrap {
  /** Guards against duplicate shutdown invocations and suppresses stale I/O errors during teardown. */
  private isShuttingDown = false;

  private constructor(
    private registry: ExtensionRegistry,
    private agentQueue: ManagedQueuePort<AgentJob>,
    private chatQueue: ManagedQueuePort<ChatJob>,
    private monitor: QueueMonitor,
    private app: AnyElysia,
    private registryInitDeps: RegistryInitDeps,
  ) {}

  /**
   * Constructs all application subsystems in dependency order:
   * 1. Model discovery (async, best-effort)
   * 2. Session store & DB initialization
   * 3. Extension registry + skill discovery
   * 4. Core queues (agents, chat, skill request)
   * 5. Web server
   */
  static async create(): Promise<AppBootstrap> {
    // ---------------------------------------------------------------------------
    // Model discovery - detect provider topology and fetch available models
    // ---------------------------------------------------------------------------
    try {
      await detectAndSetProvider();
      await fetchAvailableModels();
    } catch (err) {
      log.error("LLM endpoint unreachable - cannot detect model provider:", (err as Error).message);
      process.exit(1);
    }

    // Ensure the data directory exists and set DATA_PATH for bunqueue (it reads this env var internally)
    mkdirSync(DATA_DIR, { recursive: true });
    process.env.DATA_PATH = join(DATA_DIR, "bunqueue.db");

    // Initialize session store (opens DB, runs migrations)
    getSessionStore(getDb());

    // ---------------------------------------------------------------------------
    // Read boot-time secrets from process.env (loaded by dotenvx.config() in main.ts)
    // ---------------------------------------------------------------------------
    const openaiApiKey = process.env.OPENAI_API_KEY ?? "";
    if (!openaiApiKey) {
      log.warn("Missing OPENAI_API_KEY!");
    }

    // ---------------------------------------------------------------------------
    // Initialize secret vault
    // ---------------------------------------------------------------------------
    let secretVault: SecretVault | undefined;

    try {
      const masterKey = await deriveMasterKey();
      if (masterKey) {
        secretVault = await SecretVault.create({
          database: getDb() as any,
          masterKey,
        });
        log.info("SecretVault initialized (extension secrets available via web UI)");
      } else {
        log.warn("SecretVault disabled: no SECRETS_MASTER_KEY or .env.keys available");
      }
    } catch (err) {
      log.error("SecretVault initialization failed:", (err as Error).message);
      log.warn("Extension web secret storage will be unavailable");
    }

    // Core queue lookup for extensions
    const coreQueues = new Map<CoreQueueName, ManagedQueuePort>();

    // ---------------------------------------------------------------------------
    // Create extension registry
    // ---------------------------------------------------------------------------
    const registry = new ExtensionRegistry({
      extensionDirs: [EXTENSIONS_DIR, EXTERNAL_EXTENSIONS_DIR],
      workDir: WORK_DIR,
      dataDir: DATA_DIR,
      getCoreQueueFn: (name: CoreQueueName) => coreQueues.get(name),
      onSkillMapChanged: () => {
        log.info("Skill map changed - system prompts will update on next job");
      },
    });

    registry.registerCoreTools(
      [...SANDBOX_TOOL_NAMES].map(
        (name) =>
          ({
            name,
            label: name,
            description: "",
            parameters: {},
            execute: async () => ({ content: [], details: {} }),
          }) as AgentTool,
      ),
    );

    await registry.discoverAndLoadSkills();

    // ---------------------------------------------------------------------------
    // Create core queues
    // ---------------------------------------------------------------------------
    const { agentQueue, chatQueue, resolveSkill, getExtensionTools } = createCoreQueues({
      registry,
      openaiApiKey,
      getSelectedModel,
    });

    coreQueues.set("agents", agentQueue);
    coreQueues.set("chat", chatQueue);

    // ---------------------------------------------------------------------------
    // Create web server
    // ---------------------------------------------------------------------------
    const {
      app: elysiaApp,
      monitor: monitoring,
      pushMessage,
    } = await createWebServer({
      agentQueue,
      chatQueue,
      getRegistry: () => registry,
      secretVault,
    });

    // Route registry that wraps Elysia for extension route wiring.
    const routeRegistry: RouteRegistry = {
      registerRoute(method: HttpMethod, path: string, handler: RouteHandler) {
        const m = method.toLowerCase() as "get" | "post" | "put" | "delete";
        const app = elysiaApp as any;
        if (typeof app[m] !== "function") {
          log.error(`RouteRegistry: Elysia does not support method "${method}"`);
          return;
        }
        app[m](path, handler);
      },
    };

    // Wire lazy deps into the registry so extensions can access them during init
    const registryInitDeps = {
      routeRegistry,
      broadcastFn: (msg: WebSocketMessage) => monitoring.broadcast(msg),
      onQueueCreated: (queue: ManagedQueuePort) => monitoring.addQueues([queue]),
      database: getDb(),
      runAgentFn: createExtensionRunAgent(
        resolveSkill,
        getExtensionTools,
        () => openaiApiKey,
        () => registry.getEventBus(),
      ),
      sessionStore: getSessionStore(getDb()),
      pushMessageFn: pushMessage,
      secretVault,
    };

    return new AppBootstrap(registry, agentQueue, chatQueue, monitoring, elysiaApp, registryInitDeps);
  }

  /**
   * Starts the application: wires runtime dependencies, initializes extensions,
   * starts the web server, and registers lifecycle hooks.
   */
  async start(): Promise<void> {
    // ---------------------------------------------------------------------------
    // Register uncaught exception handler
    // ---------------------------------------------------------------------------
    process.on("uncaughtException", (err) => {
      if (this.isShuttingDown) {
        log.debug("Ignoring exception during shutdown:", err.message);
        return;
      }
      log.error("Uncaught Exception:", err, err.stack);
    });

    // ---------------------------------------------------------------------------
    // Initialize extensions (deps passed directly - no lazy resolution needed)
    // ---------------------------------------------------------------------------
    await this.registry.initializeAll(this.registryInitDeps);

    // ---------------------------------------------------------------------------
    // Wire chat event broadcasting
    // ---------------------------------------------------------------------------
    const eventBus = this.registry.getEventBus();
    const chatEventTypes = [
      "message_update",
      "tool_execution_start",
      "tool_execution_end",
      "message_end",
      "agent_end",
    ] as const;

    for (const eventType of chatEventTypes) {
      eventBus.subscribe("__chat_broadcast", eventType, (event) => {
        const chatEvent = mapAgentEventToChatEvent(event);
        if (chatEvent) this.monitor.broadcast(chatEvent);
      });
    }

    // Broadcast chat error events when agent jobs fail
    this.agentQueue.onEvent("failed", async ({ failedReason, job }) => {
      const context = (job?.data as AgentJob | undefined)?.context;
      if (context?.source === "chat" && context.id) {
        const isLLMError = isLLMConnectionError(failedReason);
        this.monitor.broadcast({
          type: "chat_event",
          chatId: context.id,
          event: "error",
          error: isLLMError ? "LLM service unavailable" : failedReason || "Agent processing failed",
        });
      }
    });

    // Broadcast chat error events when chat queue jobs fail
    this.chatQueue.onEvent("failed", async ({ failedReason, job }) => {
      const context = (job?.data as ChatJob | undefined)?.context;
      if (context?.source === "chat" && context.id) {
        const isLLMError = isLLMConnectionError(failedReason);
        this.monitor.broadcast({
          type: "chat_event",
          chatId: context.id,
          event: "error",
          error: isLLMError ? "LLM service unavailable" : failedReason || "Agent processing failed",
        });
      }
    });

    // ---------------------------------------------------------------------------
    // Wire session-to-chat mapping lifecycle
    // ---------------------------------------------------------------------------
    this.chatQueue.onEvent("active", async ({ job }) => {
      const data = job?.data as ChatJob | undefined;
      if (data?.sessionId && data?.context?.id) {
        registerSessionChat(data.sessionId, data.context.id);
      }
    });

    this.chatQueue.onEvent("completed", async ({ job }) => {
      const data = job?.data as ChatJob | undefined;
      if (data?.sessionId) {
        unregisterSessionChat(data.sessionId);
      }
    });

    this.chatQueue.onEvent("failed", async ({ job }) => {
      const data = job?.data as ChatJob | undefined;
      if (data?.sessionId) {
        unregisterSessionChat(data.sessionId);
      }
    });

    // ---------------------------------------------------------------------------
    // Start listening
    // ---------------------------------------------------------------------------
    startWebServer(this.app, { hostname: WEB_HOST, port: WEB_PORT });

    // ---------------------------------------------------------------------------
    // Periodic log cleanup - purge orphaned entries every 6 hours
    // ---------------------------------------------------------------------------
    startLogPurgeTimer(
      async () => {
        const ids = new Set<string>();
        for (const q of this.getCoreQueues()) {
          for (const job of await q.getAllJobs()) ids.add(job.id);
        }
        for (const q of this.registry.getRegisteredQueues()) {
          for (const job of await q.getAllJobs()) ids.add(job.id);
        }
        return ids;
      },
      { intervalMs: 6 * 60 * 60 * 1000, executeImmediately: true },
    );

    // ---------------------------------------------------------------------------
    // Graceful shutdown
    // ---------------------------------------------------------------------------
    process.on("SIGTERM", this.shutdown);
    process.on("SIGINT", this.shutdown);
  }

  private getCoreQueues(): ManagedQueuePort[] {
    return [this.agentQueue, this.chatQueue];
  }

  /**
   * Gracefully shuts down all subsystems.
   */
  private shutdown = async () => {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    log.info("Received signal, shutting down...");

    await this.registry.shutdownAll();
    await Promise.all(this.getCoreQueues().map((q) => q?.close()));
    shutdownManager();
    closeLogStore();
    closeDb();

    process.exit(0);
  };
}
