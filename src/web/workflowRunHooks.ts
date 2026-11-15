/**
 * Hooks through which the queue monitor's clean asks the workflows extension
 * about workflow runs, without importing the extension's stores.
 *
 * The workflows extension registers its run lifecycle on initialize; boot
 * wires the monitor's clean guard and removal callback to the functions
 * below. Without a registration every step job cleans by the normal rule and
 * nothing beyond the queue is released.
 *
 * @module
 */

import type { CleanDecision } from "./queueCleaner";

/** What the host needs to know about workflow runs during a queue clean. */
export interface WorkflowRunHooks {
  /**
   * Decides how a step job of a run takes part in a clean.
   *
   * @param runId - The run the job belongs to
   * @param cleanType - The state being cleaned
   * @returns The clean decision for the job
   */
  cleanDecision(runId: string, cleanType: string): CleanDecision;
  /**
   * Releases everything runs hold outside the queue after their jobs were cleaned.
   *
   * @param runs - Run IDs mapped to their workflow name
   */
  forget(runs: ReadonlyMap<string, string | undefined>): void;
}

let registered: WorkflowRunHooks | null = null;

/**
 * Registers the workflow run hooks (one registration; a later one replaces it).
 *
 * @param hooks - The workflows extension's run lifecycle
 * @returns A function that removes the registration (call it on shutdown)
 */
export function registerWorkflowRunHooks(hooks: WorkflowRunHooks): () => void {
  registered = hooks;
  return () => {
    if (registered === hooks) registered = null;
  };
}

/**
 * Decides how a workflow step job takes part in a clean.
 *
 * @param runId - The run the job belongs to
 * @param cleanType - The state being cleaned
 * @returns The registered decision, or `default` when no workflows extension is loaded
 */
export function workflowRunCleanDecision(runId: string, cleanType: string): CleanDecision {
  return registered ? registered.cleanDecision(runId, cleanType) : "default";
}

/**
 * Releases the non-queue resources of runs whose jobs were cleaned.
 *
 * @param runs - Run IDs mapped to their workflow name
 */
export function forgetWorkflowRuns(runs: ReadonlyMap<string, string | undefined>): void {
  registered?.forget(runs);
}
