/**
 * Chat queue - processes conversational chat jobs with a dedicated system prompt.
 */

import type { AgentEventContext, EventBus } from "@src/extensions";
import type { ManagedQueuePort, QueueJob } from "@src/queue";
import { ManagedQueue } from "@src/queue";
import type { AgentProcessorConfig, AgentProcessorResult } from "./agentProcessor";
import { runAgent } from "./agentProcessor";
import { AGENT_QUEUE_DEFAULTS } from "./defaults";

/** Payload for chat jobs. */
export interface ChatJob {
  /** Event context for routing responses (e.g. chat ID for frontend). */
  context?: AgentEventContext;
  /** Session ID for conversation context (callers must append user message before enqueuing). */
  sessionId: string;
}

/** Dependencies required to create the chat queue. */
export interface ChatQueueDeps {
  /** Builds an {@link AgentProcessorConfig} for each job at processing time (sessionId is merged from job data). */
  buildProcessor: (
    job: QueueJob<ChatJob>,
  ) => Omit<AgentProcessorConfig, "sessionId"> | Promise<Omit<AgentProcessorConfig, "sessionId">>;
  /** Getter for the event bus (resolved at job processing time). */
  getEventBus: () => EventBus;
}

/**
 * Creates a {@link ManagedQueue} for chat jobs.
 *
 * Uses a conversational system prompt optimized for user-facing interactions.
 * Event dispatching is handled centrally by `runAgent` via `config.eventBus`
 * and `config.context`.
 *
 * @param deps - Lazy getters for processor config and event bus
 * @returns The managed chat queue
 */
export function createChatQueue(deps: ChatQueueDeps): ManagedQueuePort<ChatJob> {
  const { buildProcessor, getEventBus } = deps;

  return new ManagedQueue<ChatJob, AgentProcessorResult>(
    "chat",
    async (job: QueueJob<ChatJob>) => {
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
