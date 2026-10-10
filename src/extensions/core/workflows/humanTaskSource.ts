/**
 * Connects workflow runs to the HITL service as the `workflow` task source.
 *
 * - **Answered**: the answer is delivered to the task's signal through
 *   {@link deliverSignal} (`via: "hitl"`, the only path allowed for humanTask
 *   signals), which resumes the run with the answer as the step result.
 * - **Cancelled by a manager**: the signal is cancelled and the run fails.
 * - **Timed out**: the task expires; with `onTimeout: "expire"` the run
 *   resumes with `outcome: "expired"`, otherwise the default timeout path
 *   fails the run.
 * - **Run failed or deleted**: the run's open tasks are cancelled
 *   ({@link cancelRunTasks}).
 *
 * @module
 */

import type { HitlApi, HitlTaskRecord, Logger } from "@ext/types";
import { type DagCoordinatorDeps, handleDagStepFailure } from "./dagCoordinator";
import * as dagRunStore from "./dagRunStore";
import { completedResult, expiredResult, WORKFLOW_TASK_SOURCE } from "./humanTask";
import type { DagHumanTaskStep } from "./schemas";
import { deliverSignal } from "./signalDelivery";
import * as signalStore from "./signalStore";
import * as signalTimers from "./signalTimers";

/** The workflow reference stored on a task's source. */
interface WorkflowTaskRef {
  runId: string;
  stepSlug: string;
  signalId: string;
}

/** Dependencies of {@link installHumanTaskSource}. */
export interface HumanTaskSourceDeps {
  /** The HITL service. */
  hitl: HitlApi;
  /** Coordinator dependencies (resume, fail, broadcast). */
  coordinatorDeps: DagCoordinatorDeps;
  /** Lists in-flight step job IDs of a run (cancelled when the run fails). */
  inFlightJobIds: (runId: string) => Promise<string[]>;
  /** Logger. */
  log: Logger;
}

/** Reads the workflow reference of a task, or null when malformed. */
function taskRef(task: HitlTaskRecord): WorkflowTaskRef | null {
  const { runId, stepSlug, signalId } = task.source.ref as Partial<WorkflowTaskRef>;
  return typeof runId === "string" && typeof stepSlug === "string" && typeof signalId === "string"
    ? { runId, stepSlug, signalId }
    : null;
}

/**
 * Cancels the open human tasks of a run (run failed, deleted, or cancelled).
 *
 * @param hitl - The HITL service (no-op when undefined)
 * @param runId - The workflow run ID
 * @param reason - Recorded in the task history
 * @returns The number of cancelled tasks
 */
export function cancelRunTasks(hitl: HitlApi | undefined, runId: string, reason: string): number {
  return hitl ? hitl.cancelBySource(WORKFLOW_TASK_SOURCE, runId, reason) : 0;
}

/**
 * Registers the `workflow` source handler and the humanTask timeout hook.
 *
 * @param deps - HITL service, coordinator dependencies, in-flight job lookup, logger
 * @returns A function that removes both again (call on shutdown)
 */
export function installHumanTaskSource(deps: HumanTaskSourceDeps): () => void {
  const { hitl, coordinatorDeps, log } = deps;

  const unregister = hitl.registerSourceHandler(WORKFLOW_TASK_SOURCE, {
    onCompleted(task) {
      const ref = taskRef(task);
      if (!ref) return;
      const result = deliverSignal(ref.signalId, completedResult(task, hitl), { via: "hitl", coordinatorDeps });
      if (!result.ok) {
        log.warn(`Answer to human task ${task.id} could not resume run ${ref.runId}: ${result.error}`);
      }
    },

    async onCancelled(task, reason) {
      const ref = taskRef(task);
      if (!ref) return;
      if (!signalStore.markCancelled(ref.signalId)) return;
      signalTimers.cancel(ref.signalId);
      const run = dagRunStore.get(ref.runId);
      if (!run || !dagRunStore.isActiveRunStatus(run.status)) return;
      await handleDagStepFailure(
        ref.runId,
        ref.stepSlug,
        `Human task "${task.title}" was cancelled${reason ? `: ${reason}` : ""}`,
        coordinatorDeps,
        await deps.inFlightJobIds(ref.runId),
      );
    },
  });

  signalTimers.setTimeoutHook("humanTask", (signal) => {
    const task = hitl
      .listOpenBySource(WORKFLOW_TASK_SOURCE, signal.runId)
      .find((t) => taskRef(t)?.signalId === signal.id);
    if (!task) return "default";
    hitl.expireTask(task.id);

    const run = dagRunStore.get(signal.runId);
    const stepDef = run
      ? (coordinatorDeps.getWorkflowDefinition(run.workflowName)?.steps[signal.stepSlug] as
          | DagHumanTaskStep
          | undefined)
      : undefined;
    if (stepDef?.onTimeout !== "expire") return "default";

    const result = deliverSignal(signal.id, expiredResult(task.id, Date.now()), { via: "hitl", coordinatorDeps });
    if (!result.ok) {
      log.warn(`Expired human task ${task.id} could not resume run ${signal.runId}: ${result.error}`);
      return "default";
    }
    return "handled";
  });

  return () => {
    unregister();
    signalTimers.setTimeoutHook("humanTask", null);
  };
}
