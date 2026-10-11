/**
 * Workflow run routes: rerun, run list, run detail, step logs, delete.
 *
 * @module
 */

import type { ControlFlowEvaluation } from "@shared/workflows";
import { requestUserId } from "@src/web/triggerOwnership";
import { describeControlFlowStep } from "../controlFlowEvaluation";
import * as dagRunStore from "../dagRunStore";
import { cancelRunTasks } from "../humanTaskSource";
import * as signalStore from "../signalStore";
import * as signalTimers from "../signalTimers";
import { buildStepJobIdMap, runJobs } from "../stepJobs";
import type { WorkflowRouteDeps } from "./types";

/** The open human task a waiting `humanTask` step shows on the run page. */
interface WaitingHumanTask {
  id: string;
  title: string;
  priority: string;
  dueAt: number | null;
  createdAt: number;
  /** Assigned usernames and role names. */
  assignees: { users: string[]; roles: string[] };
}

/**
 * Registers the run routes (`/runs`, `/runs/:runId/*`).
 *
 * @param deps - Shared extension state and services
 */
export function registerRunsRoutes(deps: WorkflowRouteDeps): void {
  const { ctx, logger, store, stepsQueue, hitl, dispatchAndAnnounce } = deps;

  // Starts a fresh run of a failed run's workflow with the same trigger
  // payload. The original run is left untouched (it stays failed).
  ctx.routes.register("POST", "/runs/:runId/rerun", async (reqCtx) => {
    const runId = (reqCtx.params as Record<string, string>).runId;
    if (!runId) return Response.json({ error: "Missing runId" }, { status: 400 });
    const run = dagRunStore.get(runId);
    if (!run) return Response.json({ error: "Run not found" }, { status: 404 });
    if (run.status !== "failed") {
      return Response.json({ error: "Only failed runs can be re-run" }, { status: 409 });
    }
    const wf = store.get(run.workflowName);
    if (!wf) return Response.json({ error: "Workflow not found" }, { status: 404 });

    const result = await dispatchAndAnnounce(wf, run.triggerPayload, requestUserId(reqCtx.request));
    logger.info(`Re-ran failed workflow run ${runId} as ${result.workflowRunId}`);
    return Response.json({ ok: true, workflowRunId: result.workflowRunId, jobIds: result.jobIds }, { status: 202 });
  });

  // Lightweight bulk run-status lookup. Returns one { runId, status }
  // entry per persisted run across ALL workflows in a single request, so
  // the job list can enrich workflow group badges without fanning out one
  // detail request per workflow definition (which previously tripped the
  // rate limiter after a few page loads).
  ctx.routes.register("GET", "/runs", async () => {
    const runs = dagRunStore.getAll().map((run) => ({ runId: run.id, status: run.status }));
    return Response.json(runs);
  });

  ctx.routes.register("GET", "/runs/:runId", async (reqCtx) => {
    const runId = (reqCtx.params as Record<string, string>).runId;
    if (!runId) return Response.json({ error: "Missing runId" }, { status: 400 });

    const run = dagRunStore.get(runId);
    if (!run) return Response.json({ error: "Run not found" }, { status: 404 });

    const wf = store.get(run.workflowName);

    // Waiting signal records keyed by step slug, used to enrich paused
    // waitFor steps with their event name and input schema. A run may have
    // more than one step paused concurrently.
    const waitingSignalsByStep = new Map<string, signalStore.SignalRecord>();
    for (const signal of signalStore.listWaitingForRun(runId)) {
      waitingSignalsByStep.set(signal.stepSlug, signal);
    }
    // Open human tasks keyed by the step that waits for them.
    const openTasksByStep = new Map<string, WaitingHumanTask>();
    for (const task of hitl?.listOpenBySource("workflow", runId) ?? []) {
      const stepSlug = (task.source.ref as { stepSlug?: unknown }).stepSlug;
      if (typeof stepSlug !== "string") continue;
      openTasksByStep.set(stepSlug, {
        id: task.id,
        title: task.title,
        priority: task.priority,
        dueAt: task.dueAt,
        createdAt: task.createdAt,
        assignees: {
          users: task.assignees.users.map((id) => hitl?.describeUser(id)?.username ?? id),
          roles: task.assignees.roles,
        },
      });
    }

    // Extract chosenBranch info from step results for CF nodes
    const chosenBranches: Record<string, string> = {};
    for (const [slug, result] of Object.entries(run.stepResults)) {
      if (result && typeof result === "object" && "chosenBranch" in result) {
        chosenBranches[slug] = (result as { chosenBranch: string }).chosenBranch;
      } else if (result && typeof result === "object" && "matched" in result) {
        chosenBranches[slug] = (result as { matched: string }).matched;
      }
    }

    // Map each step slug to the real queue job ID so the UI can fetch that
    // step's logs (via GET /api/jobs/:jobId/logs). The run ID is NOT a job
    // ID; steps that never produced a job (e.g. dead branches, control-flow
    // nodes) simply have no entry and get an empty jobId below.
    const stepJobIds = buildStepJobIdMap(runJobs(await stepsQueue.getAllJobs(), runId));

    const steps = Object.entries(run.stepStatuses).map(([slug, status]) => {
      const stepDef = wf?.steps[slug];
      const entry: {
        slug: string;
        type: string;
        status: string;
        jobId: string;
        waitEvent?: string;
        waitInputSchema?: Record<string, unknown> | null;
        waitSignalId?: string;
        waitScope?: signalStore.SignalScope;
        waitCorrelationKey?: string | null;
        humanTask?: WaitingHumanTask;
        evaluation?: ControlFlowEvaluation;
        error?: string;
      } = {
        slug,
        type: stepDef?.type ?? "unknown",
        status,
        jobId: stepJobIds.get(slug) ?? "",
      };
      // Control-flow nodes run inline (no job, no logs): expose how they decided.
      const evaluation = describeControlFlowStep(stepDef, run.stepResults[slug]);
      if (evaluation) entry.evaluation = evaluation;
      // A step that failed without a job failed inline in the coordinator;
      // the run's failure reason is its only error record.
      if (status === "failed" && !entry.jobId && run.failureReason) entry.error = run.failureReason;
      const signal = waitingSignalsByStep.get(slug);
      if (signal) {
        entry.waitEvent = signal.event;
        entry.waitInputSchema = signal.inputSchema as Record<string, unknown> | null;
        entry.waitSignalId = signal.id;
        entry.waitScope = signal.scope;
        entry.waitCorrelationKey = signal.correlationKey;
        const task = openTasksByStep.get(slug);
        if (task) entry.humanTask = task;
      }
      return entry;
    });

    return Response.json({
      runId,
      workflowName: run.workflowName,
      status: run.status,
      trigger: wf?.trigger ?? null,
      chosenBranches,
      steps,
    });
  });

  ctx.routes.register("GET", "/runs/:runId/logs", async (reqCtx) => {
    const runId = (reqCtx.params as Record<string, string>).runId;
    if (!runId) return Response.json({ error: "Missing runId" }, { status: 400 });
    const stepJobs = runJobs(await stepsQueue.getAllJobs(), runId);
    if (stepJobs.length === 0) return Response.json({ error: "Run not found" }, { status: 404 });

    const stepsWithLogs = await Promise.all(
      stepJobs.map(async (s) => {
        const jobLogs = await stepsQueue.getJobLogs(s.id);
        return {
          slug: s.stepSlug,
          type: s.stepDef.type,
          status: s.state,
          logs: jobLogs.logs,
          count: jobLogs.count,
        };
      }),
    );
    return Response.json({ runId, steps: stepsWithLogs });
  });

  ctx.routes.register("DELETE", "/runs/:runId", async (reqCtx) => {
    const runId = (reqCtx.params as Record<string, string>).runId;
    if (!runId) return Response.json({ error: "Missing runId" }, { status: 400 });
    const run = dagRunStore.get(runId);
    const stepJobs = runJobs(await stepsQueue.getAllJobs(), runId);
    if (stepJobs.length === 0 && !run) {
      return Response.json({ error: "Run not found" }, { status: 404 });
    }

    // Remove every step job from the queue in one batch. removeJobs handles
    // all states: live jobs (waiting / active / delayed), DLQ jobs, and
    // completed jobs (requeued then removed under a single queue pause so the
    // worker cannot re-run them). This fully purges the run's jobs, including
    // a run parked on a waitFor signal whose step jobs have all completed, so
    // they do not resurface after a restart.
    const cancelled = await stepsQueue.removeJobs(stepJobs.map((d) => d.id));

    for (const signal of signalStore.listWaitingForRun(runId)) signalTimers.cancel(signal.id);
    cancelRunTasks(hitl, runId, "Workflow run deleted");
    signalStore.deleteByRunIds([runId]);
    dagRunStore.deleteByIds([runId]);

    // Broadcast job_removed for EVERY step job of the run so connected clients
    // drop the whole group immediately, regardless of each job's prior state.
    for (const d of stepJobs) {
      ctx.messaging.broadcast({ type: "job_removed", jobId: d.id });
    }

    // Notify workflow views (e.g. the detail page's run list and counts)
    // that the run itself is gone, since it no longer exists in the run store.
    ctx.messaging.broadcast({
      type: "workflow_run_removed",
      workflowRunId: runId,
      workflowName: run?.workflowName,
    });

    logger.info(`Cancelled workflow run ${runId} (${cancelled.length}/${stepJobs.length} jobs removed)`);
    return Response.json({ runId, cancelled, total: stepJobs.length });
  });
}
