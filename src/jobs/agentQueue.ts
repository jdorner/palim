/**
 * Agent queue - processes agent prompt jobs (spell-check, telegram messages, etc.)
 * via the generic {@link createJobQueue} factory.
 */

import type { ModelIntent } from "@shared/models";
import type { AgentEventContext } from "@src/extensions";
import type { ManagedQueuePort } from "@src/queue";
import type { BaseAgentJob, JobQueueDeps } from "./jobQueueFactory";
import { createJobQueue } from "./jobQueueFactory";

/** Payload for agent prompt jobs. */
export interface AgentJob extends BaseAgentJob {
  /** Optional event context for routing responses (e.g. telegram chat ID). */
  context?: AgentEventContext;
  /** Session ID for conversation context (callers must append user message before enqueuing). */
  sessionId: string;
  /**
   * Optional model intent hint. When set, the job runs on the intent-specific
   * model (e.g. `"vision"` for messages with images) instead of the default.
   */
  intent?: ModelIntent;
}

/** Dependencies required to create the agent queue. */
export type AgentQueueDeps = JobQueueDeps<AgentJob>;

/**
 * Creates a {@link ManagedQueue} for agent prompt jobs.
 *
 * Can be called before extensions are loaded - `deps.buildProcessor` runs
 * per job, so it resolves extensions and the event bus at processing time.
 * Event dispatching is handled centrally by `runAgent` via `config.eventBus`
 * and `config.context`.
 *
 * @param deps - Per-job processor config builder and optional identity minter
 * @returns The managed agent queue
 */
export function createAgentQueue(deps: AgentQueueDeps): ManagedQueuePort<AgentJob> {
  return createJobQueue<AgentJob>("agents", deps);
}
