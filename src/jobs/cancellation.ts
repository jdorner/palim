/**
 * Lightweight cancellation registry for in-flight agent runs.
 *
 * Active {@link runAgent} calls register an {@link AbortController} keyed by
 * job ID. When a job is cancelled externally (e.g. via the REST API), the
 * controller is aborted so the underlying LLM request terminates immediately.
 */

/** Map of job ID -> AbortController for currently running agent jobs. */
const controllers = new Map<string, AbortController>();

/**
 * Register an {@link AbortController} for a running job.
 *
 * @param jobId - The queue job identifier
 * @param controller - The controller whose signal is wired into the agent
 */
export function registerJob(jobId: string, controller: AbortController): void {
  controllers.set(jobId, controller);
}

/**
 * Remove a job's controller from the registry (called on completion).
 *
 * @param jobId - The queue job identifier
 */
export function unregisterJob(jobId: string): void {
  controllers.delete(jobId);
}

/**
 * Abort a running agent job. No-op if the job isn't in the registry.
 *
 * @param jobId - The queue job identifier
 * @returns true if the job was found and aborted
 */
export function abortJob(jobId: string): boolean {
  const controller = controllers.get(jobId);
  if (controller) {
    controller.abort();
    controllers.delete(jobId);
    return true;
  }
  return false;
}
