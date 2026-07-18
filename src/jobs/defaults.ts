/**
 * Shared queue options for agent-based processors.
 */

import type { ManagedQueueOptions } from "@src/queue";

export const AGENT_QUEUE_DEFAULTS: ManagedQueueOptions = {
  concurrency: 1,
  removeOnComplete: false,
  removeOnFail: false,
  heartbeatInterval: 1000,
  lockDuration: 1000 * 60 * 5,
  useLocks: false,
  stallConfig: { stallInterval: 1000 * 60 * 5, maxStalls: 1, gracePeriod: 15000, enabled: true },
};
