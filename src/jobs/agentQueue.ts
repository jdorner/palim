/**
 * Agent queue - processes agent prompt jobs (spell-check, telegram messages, etc.)
 * via the generic {@link createJobQueue} factory.
 */

import type { AgentEventContext } from "@src/extensions";
import type { ManagedQueuePort } from "@src/queue";
import type { BaseAgentJob, JobQueueDeps } from "./jobQueueFactory";
import { createJobQueue } from "./jobQueueFactory";

/** Payload for agent prompt jobs. */
export interface AgentJob extends BaseAgentJob {
  /** Optional event context for routing responses (e.g. telegram chat ID). */
  context?: AgentEventContext;
  /** Optional system prompt override. */
  systemPrompt?: string;
  /** Session ID for conversation context (callers must append user message before enqueuing). */
  sessionId: string;
}

/** Dependencies required to create the agent queue. */
export type AgentQueueDeps = JobQueueDeps<AgentJob>;

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
  return createJobQueue<AgentJob>("agents", deps);
}
