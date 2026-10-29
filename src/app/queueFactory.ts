/**
 * Core queue creation factory.
 *
 * Encapsulates the construction of the agent and chat queues with their
 * per-job processor configs.
 *
 * @module
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import type { ModelIntent } from "@shared/models";
import type { CoreQueueName, ExtensionRegistry } from "@src/extensions";
import type { AgentJob, ChatJob } from "@src/jobs";
import { buildAgentSystemPrompt, buildChatSystemPrompt, createJobQueue } from "@src/jobs";
import { getModelForIntent } from "@src/models";
import type { ManagedQueuePort, QueueJob } from "@src/queue";
import { getSkillsForContext } from "@src/skills/skills";
import type { SkillEntry } from "@src/tools/sandbox";
import { createShell } from "@src/tools/sandbox";
import type { Bash } from "just-bash";
import createLogger from "logging";

const logger = createLogger("Queues");

/** Dependencies needed to construct the core queues. */
export interface CoreQueueDeps {
  /** The extension registry (for skill/tool resolution at job time). */
  registry: ExtensionRegistry;
  /** API key for the LLM provider. */
  openaiApiKey: string;
  /** Resolves the currently selected model at job processing time. */
  getSelectedModel: () => Promise<Model<"openai-completions">>;
  /**
   * Mints a short-lived internal bearer token for a job's initiating user so
   * internal calls during processing authorize as that user. Optional; when
   * absent, jobs run under the ambient/system identity.
   */
  mintIdentityToken?: (userId: string) => string | null;
}

/** Result of core queue creation. */
export interface CoreQueues {
  /** Queue for general agent prompt jobs. */
  agentQueue: ManagedQueuePort<AgentJob>;
  /** Queue for conversational chat jobs. */
  chatQueue: ManagedQueuePort<ChatJob>;
  /** Resolves a skill name to its entry (shared with the registry). */
  resolveSkill: (name: string) => SkillEntry | undefined;
  /** Returns all extension-registered tools (live reference). */
  getExtensionTools: () => AgentTool[];
  /** Creates a shell scoped to the given skills and session. */
  shellFactory: (skills: string[], sessionId: string) => Promise<Bash>;
}

/**
 * Creates the core agent and chat queues with their processor callbacks.
 *
 * Processor configs are built per job, so skills, tools, and the event bus
 * from extensions loaded after queue creation are still visible.
 *
 * @param deps - Registry, API key, and model resolver
 * @returns The created queues and shared resolution helpers
 */
export function createCoreQueues(deps: CoreQueueDeps): CoreQueues {
  const { registry, openaiApiKey, getSelectedModel, mintIdentityToken } = deps;

  const resolveSkill = (name: string) => registry.resolveSkill(name);
  const shellFactory = (skills: string[], sessionId: string) => createShell({ skills, resolveSkill, sessionId });
  const getExtensionTools = (): AgentTool[] => registry.getRegisteredTools();
  const resolveExtensionTool = (name: string): AgentTool | undefined =>
    getExtensionTools().find((t) => t.name === name);

  /**
   * Resolves the model for a job's intent hint, falling back to the selected
   * model when the intent cannot be satisfied (e.g. no vision model configured).
   * The fallback keeps the job running; pi-ai replaces unsupported images with
   * a placeholder instead of failing the request.
   */
  const resolveModel = async (intent?: ModelIntent): Promise<Model<"openai-completions">> => {
    if (!intent) return getSelectedModel();
    try {
      return (await getModelForIntent(intent)).model;
    } catch (err) {
      logger.warn(
        `Could not resolve model for intent "${intent}", using selected model: ${err instanceof Error ? err.message : String(err)}`,
      );
      return getSelectedModel();
    }
  };

  /**
   * Creates one core queue. The two queues differ only in their system prompt,
   * the sandbox tools they get, and how the model is picked.
   */
  const createCoreQueue = <T extends ChatJob>(
    queue: CoreQueueName,
    variant: {
      buildSystemPrompt: (skillsContext: string) => string;
      sandboxTools: string[];
      pickModel: (job: QueueJob<T>) => Promise<Model<"openai-completions">>;
    },
  ): ManagedQueuePort<T> =>
    createJobQueue<T>(queue, {
      buildProcessor: async (job) => {
        const activeSkills = registry.getSkillNames();
        return {
          model: await variant.pickModel(job),
          tools: [...variant.sandboxTools, ...getExtensionTools().map((t) => t.name)],
          toolResolver: resolveExtensionTool,
          apiKey: openaiApiKey,
          systemPrompt: variant.buildSystemPrompt(getSkillsForContext({ resolveSkill, includeSkills: activeSkills })),
          shellFactory,
          skills: activeSkills,
          eventBus: registry.getEventBus(),
          queue,
          context: job.data.context,
        };
      },
      mintIdentityToken,
    });

  const agentQueue = createCoreQueue<AgentJob>("agents", {
    buildSystemPrompt: buildAgentSystemPrompt,
    sandboxTools: ["exec"],
    pickModel: (job) => resolveModel(job.data.intent),
  });

  const chatQueue = createCoreQueue<ChatJob>("chat", {
    buildSystemPrompt: buildChatSystemPrompt,
    sandboxTools: ["exec", "edit"],
    pickModel: () => getSelectedModel(),
  });

  return { agentQueue, chatQueue, resolveSkill, getExtensionTools, shellFactory };
}
