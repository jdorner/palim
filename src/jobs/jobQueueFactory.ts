/**
 * Job payloads and queue factory for the core agent-based queues
 * (`agents` and `chat`).
 *
 * Both queues share the same processing pattern: resolve the initiator
 * identity, build a processor config for the job, merge the session ID from the
 * job payload, then run the agent. They differ only in the processor config,
 * which the caller supplies per job (see `src/app/queueFactory.ts`).
 *
 * @module
 */

import type { ModelIntent } from "@shared/models";
import { resolveInitiatorToken } from "@src/auth/identityMinter";
import type { AgentEventContext } from "@src/extensions";
import type { EventBus } from "@src/extensions/engine/eventBus";
import type { ManagedQueueOptions, ManagedQueuePort, QueueJob } from "@src/queue";
import { ManagedQueue } from "@src/queue";
import { runWithIdentity } from "@src/utils/fetch";
import type { AgentProcessorConfig, AgentProcessorResult } from "./agentProcessor";
import { runAgent } from "./agentProcessor";

/** Payload for jobs on the core `agents` queue (telegram messages, extension-triggered prompts, ...). */
export interface AgentJob {
  /** Optional event context for routing responses (e.g. chat ID, telegram chat ID). */
  context?: AgentEventContext;
  /** Session ID for conversation context (callers must append the user message before enqueuing). */
  sessionId: string;
  /**
   * Id of the user who initiated this job. Internal calls made while processing
   * the job authorize as this user (confused-deputy fix). If the user can no
   * longer be authenticated (disabled/deleted) the job is refused. Absent for
   * genuine system-initiated background work, which runs as the system principal.
   */
  initiatorUserId?: string;
  /**
   * Optional model intent hint. When set, the job runs on the intent-specific
   * model (e.g. `"vision"` for messages with images) instead of the default.
   */
  intent?: ModelIntent;
}

/** Payload for jobs on the core `chat` queue. Chat always runs on the selected model, so it has no intent hint. */
export type ChatJob = Omit<AgentJob, "intent">;

/**
 * Per-job processor config for a core queue. The session ID is merged from the
 * job payload. `eventBus` is required here (it is optional for other
 * `runAgent` callers) so `before_agent_start` hooks always run for core queues.
 */
export type CoreProcessorConfig = Omit<AgentProcessorConfig, "sessionId"> & { eventBus: EventBus };

/**
 * Dependencies required to create a core agent-based job queue.
 *
 * @typeParam T - The job payload type
 */
export interface JobQueueDeps<T extends ChatJob> {
  /**
   * Builds the processor config for each job at processing time. Runs per job,
   * so it sees extensions, skills, and the event bus as they are when the job
   * is processed.
   */
  buildProcessor: (job: QueueJob<T>) => Promise<CoreProcessorConfig>;
  /**
   * Mints a short-lived internal bearer token for the given initiating user, so
   * internal calls during processing authorize as that user. Returns null when
   * minting fails (e.g. the user is disabled or deleted), in which case a job
   * that records an initiator is refused.
   */
  mintIdentityToken?: (userId: string) => string | null;
}

/** Queue options shared by the core agent-based queues. */
const AGENT_QUEUE_OPTIONS: ManagedQueueOptions = {
  concurrency: 1,
  removeOnComplete: false,
  removeOnFail: false,
  heartbeatInterval: 1000,
  lockDuration: 1000 * 60 * 5,
  useLocks: false,
  stallConfig: { stallInterval: 1000 * 60 * 5, maxStalls: 1, gracePeriod: 15000, enabled: true },
};

/**
 * Creates a {@link ManagedQueue} for agent-based jobs.
 *
 * Can be called before extensions are loaded: `deps.buildProcessor` runs per
 * job. Event dispatching is handled centrally by `runAgent` via
 * `config.eventBus` and `config.context`.
 *
 * @typeParam T - The job payload type
 * @param name - Queue name (`"agents"` or `"chat"`)
 * @param deps - Per-job processor config builder and optional identity minter
 * @returns The managed queue instance
 * @throws (at job time) when the job's recorded initiator can no longer be authenticated
 */
export function createJobQueue<T extends ChatJob>(name: string, deps: JobQueueDeps<T>): ManagedQueuePort<T> {
  const { buildProcessor, mintIdentityToken } = deps;

  return new ManagedQueue<T, AgentProcessorResult>(
    name,
    async (job: QueueJob<T>) => {
      // Resolve identity before doing any work: throws (refusing the job) when
      // the recorded initiator is disabled/deleted instead of running as system.
      const token = resolveInitiatorToken(job.data.initiatorUserId, mintIdentityToken);

      const config = await buildProcessor(job);

      const process = () => runAgent(job, { ...config, sessionId: job.data.sessionId });

      // Bind the job's initiating identity for the duration of processing so any
      // internal call (skills, ctx.fetch, push) authorizes as that user rather
      // than a shared privileged identity.
      if (token) {
        return runWithIdentity(token, process, job.data.initiatorUserId);
      }
      return process();
    },
    AGENT_QUEUE_OPTIONS,
  );
}
