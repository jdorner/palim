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

import { resolveInitiatorToken } from "@src/auth/identityMinter";
import type { AgentEventContext, EventBus } from "@src/extensions";
import type { ManagedQueuePort, QueueJob } from "@src/queue";
import { ManagedQueue } from "@src/queue";
import { runWithIdentity } from "@src/utils/fetch";
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
  /**
   * Id of the user who initiated this job. Internal calls made while processing
   * the job authorize as this user (confused-deputy fix). If the user can no
   * longer be authenticated (disabled/deleted) the job is refused. Absent for
   * genuine system-initiated background work, which runs as the system principal.
   */
  initiatorUserId?: string;
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
  /**
   * Mints a short-lived internal bearer token for the given initiating user, so
   * internal calls during processing authorize as that user. Returns null when
   * minting fails (e.g. the user is disabled or deleted), in which case a job
   * that records an initiator is refused.
   */
  mintIdentityToken?: (userId: string) => string | null;
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
  const { buildProcessor, getEventBus, mintIdentityToken } = deps;

  return new ManagedQueue<T, AgentProcessorResult>(
    name,
    async (job: QueueJob<T>) => {
      // Resolve identity before doing any work: throws (refusing the job) when
      // the recorded initiator is disabled/deleted instead of running as system.
      const token = resolveInitiatorToken(job.data.initiatorUserId, mintIdentityToken);

      const config = await buildProcessor(job);

      const process = () =>
        runAgent(job, {
          ...config,
          sessionId: job.data.sessionId,
          eventBus: config.eventBus ?? getEventBus(),
          context: config.context ?? job.data?.context,
        });

      // Bind the job's initiating identity for the duration of processing so any
      // internal call (skills, ctx.fetch, push) authorizes as that user rather
      // than a shared privileged identity.
      if (token) {
        return runWithIdentity(token, process, job.data.initiatorUserId);
      }
      return process();
    },
    AGENT_QUEUE_DEFAULTS,
  );
}
