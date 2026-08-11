/**
 * Chat queue - processes conversational chat jobs with a dedicated system prompt
 * via the generic {@link createJobQueue} factory.
 */

import type { AgentEventContext } from "@src/extensions";
import type { ManagedQueuePort } from "@src/queue";
import type { BaseAgentJob, JobQueueDeps } from "./jobQueueFactory";
import { createJobQueue } from "./jobQueueFactory";

/** Payload for chat jobs. */
export interface ChatJob extends BaseAgentJob {
  /** Event context for routing responses (e.g. chat ID for frontend). */
  context?: AgentEventContext;
  /** Session ID for conversation context (callers must append user message before enqueuing). */
  sessionId: string;
}

/** Dependencies required to create the chat queue. */
export type ChatQueueDeps = JobQueueDeps<ChatJob>;

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
  return createJobQueue<ChatJob>("chat", deps);
}
