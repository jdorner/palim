/**
 * Core queue creation factory.
 *
 * Encapsulates the construction of the agent and chat queues with their
 * buildProcessor callbacks
 *
 * @module
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionRegistry } from "@src/extensions";
import type { AgentJob, ChatJob } from "@src/jobs";
import { buildAgentSystemPrompt, buildChatSystemPrompt, createAgentQueue, createChatQueue } from "@src/jobs";
import type { ManagedQueuePort, QueueJob } from "@src/queue";
import { getSkillsForContext } from "@src/skills/skills";
import type { SkillEntry } from "@src/tools/sandbox";
import { createShell } from "@src/tools/sandbox";
import type { Bash } from "just-bash";

/** Dependencies needed to construct the core queues. */
export interface CoreQueueDeps {
  /** The extension registry (for skill/tool resolution at job time). */
  registry: ExtensionRegistry;
  /** API key for the LLM provider. */
  openaiApiKey: string;
  /** Resolves the currently selected model at job processing time. */
  getSelectedModel: () => Promise<Model<"openai-completions">>;
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
 * Queue processors resolve dependencies lazily at job time via getter
 * functions, so extensions loaded after queue creation are still visible.
 *
 * @param deps - Registry, API key, and model resolver
 * @returns The created queues and shared resolution helpers
 */
export function createCoreQueues(deps: CoreQueueDeps): CoreQueues {
  const { registry, openaiApiKey, getSelectedModel } = deps;

  const resolveSkill = (name: string) => registry.resolveSkill(name);
  const shellFactory = (skills: string[], sessionId: string) => createShell({ skills, resolveSkill, sessionId });
  const getExtensionTools = (): AgentTool[] => registry.getRegisteredTools();
  const resolveExtensionTool = (name: string): AgentTool | undefined =>
    getExtensionTools().find((t) => t.name === name);

  const agentQueue = createAgentQueue({
    buildProcessor: async (job: QueueJob<AgentJob>) => {
      const activeSkills = registry.getSkillNames();
      const systemPrompt = buildAgentSystemPrompt(getSkillsForContext({ resolveSkill, includeSkills: activeSkills }));
      return {
        model: await getSelectedModel(),
        tools: ["exec", ...getExtensionTools().map((t) => t.name)],
        toolResolver: resolveExtensionTool,
        apiKey: openaiApiKey,
        systemPrompt,
        shellFactory,
        skills: activeSkills,
        eventBus: registry.getEventBus(),
        queue: "agents" as const,
        context: job.data.context,
      };
    },
    getEventBus: () => registry.getEventBus(),
  });

  const chatQueue = createChatQueue({
    buildProcessor: async (job: QueueJob<ChatJob>) => {
      const activeSkills = registry.getSkillNames();
      const systemPrompt = buildChatSystemPrompt(getSkillsForContext({ resolveSkill, includeSkills: activeSkills }));
      return {
        model: await getSelectedModel(),
        tools: ["exec", "edit", ...getExtensionTools().map((t) => t.name)],
        toolResolver: resolveExtensionTool,
        apiKey: openaiApiKey,
        systemPrompt,
        shellFactory,
        skills: activeSkills,
        eventBus: registry.getEventBus(),
        queue: "chat" as const,
        context: job.data.context,
      };
    },
    getEventBus: () => registry.getEventBus(),
  });

  return { agentQueue, chatQueue, resolveSkill, getExtensionTools, shellFactory };
}
