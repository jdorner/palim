/**
 * Agent queue - processes agent prompt jobs (spell-check, telegram messages, etc.)
 * via the {@link ManagedQueue} abstraction.
 */

import type { AgentEventContext, EventBus } from "@src/extensions";
import type { ManagedQueuePort, QueueJob } from "@src/queue";
import { ManagedQueue } from "@src/queue";
import type { AgentProcessorConfig, AgentProcessorResult } from "./agentProcessor";
import { runAgent } from "./agentProcessor";
import { AGENT_QUEUE_DEFAULTS } from "./defaults";

/** Payload for agent prompt jobs. */
export interface AgentJob {
  /** Optional event context for routing responses (e.g. telegram chat ID). */
  context?: AgentEventContext;
  /** Optional system prompt override. */
  systemPrompt?: string;
  /** Session ID for conversation context (callers must append user message before enqueuing). */
  sessionId: string;
}

/** Dependencies required to create the agent queue. */
export interface AgentQueueDeps {
  /** Builds an {@link AgentProcessorConfig} for each job at processing time (sessionId is merged from job data). */
  buildProcessor: (
    job: QueueJob<AgentJob>,
  ) => Omit<AgentProcessorConfig, "sessionId"> | Promise<Omit<AgentProcessorConfig, "sessionId">>;
  /** Getter for the event bus (resolved at job processing time). */
  getEventBus: () => EventBus;
}

/**
 * Creates a {@link ManagedQueue} for agent prompt jobs.
 *
 * Can be called before extensions are loaded - the processor resolves
 * dependencies lazily via getter functions at job processing time.
 * Event dispatching is handled centrally by `runAgent` via `config.eventBus`
 * and `config.context`.
 *
 * @param deps - Lazy getters for processor config and event bus
 * @returns The managed agent queue
 */
export function createAgentQueue(deps: AgentQueueDeps): ManagedQueuePort<AgentJob> {
  const { buildProcessor, getEventBus } = deps;

  return new ManagedQueue<AgentJob, AgentProcessorResult>(
    "agents",
    async (job: QueueJob<AgentJob>) => {
      const config = await buildProcessor(job);

      return runAgent(job, {
        ...config,
        sessionId: job.data.sessionId,
        eventBus: config.eventBus ?? getEventBus(),
        context: config.context ?? job.data?.context,
      });
    },
    AGENT_QUEUE_DEFAULTS,
  );
}
