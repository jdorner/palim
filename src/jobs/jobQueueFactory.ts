/**
 * Generic job queue factory for agent-based processors.
 *
 * Both the agent queue and chat queue share the same processing pattern:
 * build a processor config, merge the session ID from the job payload,
 * fall back to the event bus and context from the job data, then run
 * the agent. This module extracts that shared logic into a single
 * generic factory parameterized by the job payload type.
 *
 * @module
 */

import type { AgentEventContext, EventBus } from "@src/extensions";
import type { ManagedQueuePort, QueueJob } from "@src/queue";
import { ManagedQueue } from "@src/queue";
import type { AgentProcessorConfig, AgentProcessorResult } from "./agentProcessor";
import { runAgent } from "./agentProcessor";
import { AGENT_QUEUE_DEFAULTS } from "./defaults";

/**
 * Base constraint for job payloads processed by agent queues.
 * All agent-based job types must carry a session ID and an optional
 * event routing context.
 */
export interface BaseAgentJob {
  /** Optional event context for routing responses (e.g. chat ID, telegram chat ID). */
  context?: AgentEventContext;
  /** Session ID for conversation context (callers must append user message before enqueuing). */
  sessionId: string;
}

/**
 * Dependencies required to create an agent-based job queue.
 *
 * @typeParam T - The job payload type (must extend {@link BaseAgentJob})
 */
export interface JobQueueDeps<T extends BaseAgentJob> {
  /** Builds an {@link AgentProcessorConfig} for each job at processing time (sessionId is merged from job data). */
  buildProcessor: (
    job: QueueJob<T>,
  ) => Omit<AgentProcessorConfig, "sessionId"> | Promise<Omit<AgentProcessorConfig, "sessionId">>;
  /** Getter for the event bus (resolved at job processing time). */
  getEventBus: () => EventBus;
}

/**
 * Creates a {@link ManagedQueue} for agent-based jobs.
 *
 * The processor resolves dependencies lazily via getter functions at job
 * processing time, so extensions loaded after queue creation are still visible.
 * Event dispatching is handled centrally by `runAgent` via `config.eventBus`
 * and `config.context`.
 *
 * @typeParam T - The job payload type (must extend {@link BaseAgentJob})
 * @param name - Queue name (e.g. "agents", "chat")
 * @param deps - Lazy getters for processor config and event bus
 * @returns The managed queue instance
 */
export function createJobQueue<T extends BaseAgentJob>(name: string, deps: JobQueueDeps<T>): ManagedQueuePort<T> {
  const { buildProcessor, getEventBus } = deps;

  return new ManagedQueue<T, AgentProcessorResult>(
    name,
    async (job: QueueJob<T>) => {
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
