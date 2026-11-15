/**
 * Owner of the workflow run lifecycle.
 *
 * A run's state lives in five places: the steps queue (its jobs), the run
 * store, the signal store, the in-memory signal timers, and open human tasks.
 * {@link createWorkflowRuns} is the only code that touches all of them
 * together: it starts and re-runs runs, describes them, tears them down, and
 * feeds queue events into the coordinator. Routes and the host's queue
 * monitor ask it instead of assembling a run from its parts.
 *
 * @module
 */

import type { DomainEvent, HitlApi, Logger, ManagedQueuePort } from "@ext/types";
import type { ControlFlowEvaluation, WorkflowWebSocketEvent } from "@shared/workflows";
import type { FlowProducer } from "bunqueue/client";
import { describeControlFlowStep } from "./controlFlowEvaluation";
import {
  type DagCoordinatorDeps,
  handleDagStepCompletion,
  handleDagStepFailure,
  signalTimeoutDeps,
  startRun,
} from "./dagCoordinator";
import type { DagStepJobData, SessionFactory } from "./dagEngine";
import * as dagRunStore from "./dagRunStore";
import { cancelRunTasks, installHumanTaskSource } from "./humanTaskSource";
import type { DagWorkflowDefinition } from "./schemas";
import * as signalStore from "./signalStore";
import * as signalTimers from "./signalTimers";
import { buildStepJobIdMap, runJobs, stepData } from "./stepJobs";

/** The queue operations the run lifecycle needs from the steps queue. */
export type StepsQueue = Pick<
  ManagedQueuePort<DagStepJobData>,
  "getAllJobs" | "cancelJob" | "removeJobs" | "getJobLogs" | "onEvent"
>;

/** Messages the run lifecycle broadcasts to connected clients. */
export type WorkflowRunsMessage = WorkflowWebSocketEvent | { type: "job_removed"; jobId: string };

/** Dependencies of {@link createWorkflowRuns}. */
export interface WorkflowRunsDeps {
  /** The steps queue; only this module reads or changes its jobs. */
  stepsQueue: StepsQueue;
  /** Dispatches step jobs. */
  flowProducer: FlowProducer;
  /** Creates per-step sessions. */
  sessionFactory: SessionFactory;
  log: Logger;
  /** Broadcasts a message to connected clients. */
  broadcast: (message: WorkflowRunsMessage) => void;
  /** Emits a domain event for other extensions (e.g. `workflow:step_failed`). */
  emitEvent: (event: DomainEvent) => void;
  /** Looks up a loaded workflow definition by name. */
  getWorkflowDefinition: (name: string) => DagWorkflowDefinition | undefined;
  /** Human task service (absent when HITL is not configured). */
  hitl: HitlApi | undefined;
}

/** A started run. */
export interface StartedRun {
  workflowRunId: string;
  jobIds: string[];
}

/** Outcome of {@link WorkflowRuns.rerun}. */
export type RerunResult =
  | ({ ok: true } & StartedRun)
  | { ok: false; reason: "run_not_found" | "not_failed" | "workflow_not_found" };

/** The open human task a waiting `humanTask` step shows on the run page. */
export interface WaitingHumanTask {
  id: string;
  title: string;
  priority: string;
  dueAt: number | null;
  createdAt: number;
  /** Assigned usernames and role names. */
  assignees: { users: string[]; roles: string[] };
}

/** One step of a {@link RunDescription}. */
export interface RunStepDescription {
  slug: string;
  type: string;
  status: string;
  /** Queue job that ran the step, or `""` for steps without a job (control flow, dead branches). */
  jobId: string;
  waitEvent?: string;
  waitInputSchema?: Record<string, unknown> | null;
  waitSignalId?: string;
  waitScope?: signalStore.SignalScope;
  waitCorrelationKey?: string | null;
  humanTask?: WaitingHumanTask;
  evaluation?: ControlFlowEvaluation;
  error?: string;
  result?: unknown;
}

/** A run as the run page shows it. */
export interface RunDescription {
  runId: string;
  workflowName: string;
  status: dagRunStore.DagRunStatus;
  failureReason?: string;
  trigger: DagWorkflowDefinition["trigger"] | null;
  /** Branch chosen by each decided control-flow node. */
  chosenBranches: Record<string, string>;
  steps: RunStepDescription[];
}

/** Per-step execution logs of a run. */
export interface RunStepLogs {
  runId: string;
  steps: {
    slug: string;
    type: string;
    status: string;
    logs: Awaited<ReturnType<StepsQueue["getJobLogs"]>>["logs"];
    count: number;
  }[];
}

/** How a clean of the queue treats one workflow step job (see the host's queue cleaner). */
export type RunCleanDecision = "keep" | "remove" | "default";

/** The run lifecycle of one workflows extension instance. */
export interface WorkflowRuns {
  /**
   * Starts a run (announces `workflow_started` and activates every root step).
   *
   * @param wf - The workflow definition
   * @param payload - The trigger payload (`undefined` is stored as `null`)
   * @param initiatorUserId - The user the run acts for, if any
   * @returns The run ID and the IDs of the enqueued root jobs
   */
  start(wf: DagWorkflowDefinition, payload: unknown, initiatorUserId?: string): Promise<StartedRun>;
  /**
   * Starts a fresh run of a failed run's workflow with the same trigger
   * payload. The original run stays failed.
   *
   * @param runId - The failed run
   * @param initiatorUserId - The user starting the new run
   * @returns The new run, or why it could not be started
   */
  rerun(runId: string, initiatorUserId?: string): Promise<RerunResult>;
  /**
   * Describes a run with per-step status, job IDs, waits, and control-flow decisions.
   *
   * @param runId - The run
   * @param opts - `resultsFor`: add persisted step results when this user started the run
   *   (results can hold resolved secrets, so nobody else gets them, and runs without
   *   a recorded starter never do)
   * @returns The description, or null when the run does not exist
   */
  describe(runId: string, opts?: { resultsFor?: string }): Promise<RunDescription | null>;
  /**
   * Reads the execution logs of each step job of a run.
   *
   * @param runId - The run
   * @returns The logs, or null when the run has no jobs
   */
  stepLogs(runId: string): Promise<RunStepLogs | null>;
  /**
   * Deletes a run: removes all its jobs from the queue (any state), then
   * releases its other resources (see {@link forget}).
   *
   * @param runId - The run
   * @returns Removed job IDs and the run's job count, or null when neither the run nor any job exists
   */
  remove(runId: string): Promise<{ cancelled: string[]; total: number } | null>;
  /**
   * Releases everything a run holds outside the queue: signal timers, open
   * human tasks, signal records, and the run record, then announces
   * `workflow_run_removed`. For runs whose jobs were already removed
   * elsewhere (the queue monitor's clean).
   *
   * @param runs - Run IDs mapped to their workflow name (used in the broadcast when the run record is gone)
   */
  forget(runs: ReadonlyMap<string, string | undefined>): void;
  /**
   * Decides how a step job of a run takes part in a queue clean. A run's
   * steps are cleaned together when the run's status matches the clean type,
   * because a step's own queue state does not reflect the run (a step is
   * "completed" while its run still waits on a signal, and a failed run's
   * steps are a mix of completed and failed).
   *
   * @param runId - The run the job belongs to
   * @param cleanType - The state being cleaned ("completed", "failed", ...)
   * @returns `keep` for active runs and status mismatches, `remove` for a match, `default` for unknown runs
   */
  cleanDecision(runId: string, cleanType: string): RunCleanDecision;
  /**
   * Status of every persisted run.
   *
   * @returns One entry per run
   */
  statuses(): { runId: string; status: dagRunStore.DagRunStatus }[];
  /**
   * Coordinator dependencies for code that delivers signals (signal routes,
   * the emit step, human tasks); they all go through `deliverSignal`.
   */
  readonly coordinatorDeps: DagCoordinatorDeps;
  /** Stops timers and unregisters the human task source. */
  dispose(): void;
}

/**
 * Creates the run lifecycle and subscribes it to the steps queue's events.
 * Re-arms the signal timeouts of runs that were waiting before a restart.
 *
 * @param deps - Queue, dispatch, broadcast, and lookup dependencies
 * @returns The run lifecycle
 */
export function createWorkflowRuns(deps: WorkflowRunsDeps): WorkflowRuns {
  const { stepsQueue, hitl, log } = deps;

  /** All step jobs of a run, in any state. The only place that scans the queue for a run. */
  const jobsOf = async (runId: string) => runJobs(await stepsQueue.getAllJobs(), runId);

  /** Queued and active jobs of a run (cancelled when the run fails). */
  const inFlightJobIds = async (runId: string): Promise<string[]> =>
    (await jobsOf(runId))
      .filter((s) => s.state === "active" || s.state === "waiting" || s.state === "delayed")
      .map((s) => s.id);

  const coordinatorDeps: DagCoordinatorDeps = {
    flowProducer: deps.flowProducer,
    sessionFactory: deps.sessionFactory,
    log,
    broadcast: (event) => {
      // Every failure path announces workflow_failed; a failed run's open
      // human tasks can no longer be answered.
      if (event.type === "workflow_failed") {
        cancelRunTasks(hitl, event.workflowRunId, `Workflow run failed: ${event.error}`);
      }
      deps.broadcast(event);
    },
    getWorkflowDefinition: deps.getWorkflowDefinition,
    cancelJob: async (jobId) => {
      await stepsQueue.cancelJob(jobId);
    },
    inFlightJobIds,
    hitl,
  };

  // Answers, cancellations, and timeouts of human tasks drive their runs.
  const uninstallHumanTasks = hitl ? installHumanTaskSource({ hitl, coordinatorDeps, log, inFlightJobIds }) : null;

  // Timeout timers live in memory: re-arm the ones of runs still parked on a
  // signal from before the restart (elapsed deadlines fire immediately).
  const rearmed = signalTimers.rearmWaiting(signalTimeoutDeps(coordinatorDeps));
  if (rearmed > 0) log.info(`Re-armed ${rearmed} signal timeout(s)`);

  // --- Queue events -> coordinator + broadcasts ---

  stepsQueue.onEvent("active", ({ job }) => {
    if (!job) return;
    const d = stepData(job);
    deps.broadcast({
      type: "workflow_step_started",
      workflowRunId: d.workflowRunId,
      stepSlug: d.stepSlug,
      jobId: d.id,
    });
  });

  stepsQueue.onEvent("completed", async ({ job }) => {
    if (!job) return;
    const d = stepData(job);
    await handleDagStepCompletion(d.workflowRunId, d.stepSlug, job.returnvalue, d.id, coordinatorDeps);
  });

  stepsQueue.onEvent("failed", async ({ jobId, failedReason, job }) => {
    if (!job) return;
    const d = stepData(job);
    deps.broadcast({
      type: "workflow_step_failed",
      workflowRunId: d.workflowRunId,
      stepSlug: d.stepSlug,
      jobId: d.id,
      error: failedReason,
    });

    // Only fail the run once the job is truly failed (not a retry delay).
    if (d.state !== "failed") return;
    // Fail-fast: the coordinator cancels the run's in-flight jobs.
    await handleDagStepFailure(d.workflowRunId, d.stepSlug, failedReason, coordinatorDeps);
    // Domain event for cross-extension consumers (e.g. error-analyzer).
    deps.emitEvent({
      type: "workflow:step_failed",
      context: {
        source: "workflows",
        id: d.workflowRunId,
        workflowRunId: d.workflowRunId,
        workflowName: d.workflowName,
        stepSlug: d.stepSlug,
        jobId,
        error: failedReason,
      },
    });
  });

  // --- Lifecycle operations ---

  function start(wf: DagWorkflowDefinition, payload: unknown, initiatorUserId?: string): Promise<StartedRun> {
    return startRun(wf, payload ?? null, coordinatorDeps, initiatorUserId);
  }

  function forget(runs: ReadonlyMap<string, string | undefined>): void {
    if (runs.size === 0) return;
    const ids = [...runs.keys()];
    for (const runId of ids) {
      for (const signal of signalStore.listWaitingForRun(runId)) signalTimers.cancel(signal.id);
      cancelRunTasks(hitl, runId, "Workflow run deleted");
    }
    signalStore.deleteByRunIds(ids);
    dagRunStore.deleteByIds(ids);
    // Workflow views (run list, counts) drop the run, which no longer exists in the store.
    for (const [runId, workflowName] of runs) {
      deps.broadcast({ type: "workflow_run_removed", workflowRunId: runId, workflowName });
    }
  }

  return {
    coordinatorDeps,
    start,
    forget,

    async rerun(runId, initiatorUserId) {
      const run = dagRunStore.get(runId);
      if (!run) return { ok: false, reason: "run_not_found" };
      if (run.status !== "failed") return { ok: false, reason: "not_failed" };
      const wf = deps.getWorkflowDefinition(run.workflowName);
      if (!wf) return { ok: false, reason: "workflow_not_found" };
      const started = await start(wf, run.triggerPayload, initiatorUserId);
      log.info(`Re-ran failed workflow run ${runId} as ${started.workflowRunId}`);
      return { ok: true, ...started };
    },

    async describe(runId, opts = {}) {
      const run = dagRunStore.get(runId);
      if (!run) return null;
      const wf = deps.getWorkflowDefinition(run.workflowName);
      const includeResults = opts.resultsFor !== undefined && run.createdByUserId === opts.resultsFor;

      // A run may have more than one step paused concurrently.
      const waitingSignalsByStep = new Map<string, signalStore.SignalRecord>();
      for (const signal of signalStore.listWaitingForRun(runId)) {
        waitingSignalsByStep.set(signal.stepSlug, signal);
      }
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

      const chosenBranches: Record<string, string> = {};
      for (const [slug, result] of Object.entries(run.stepResults)) {
        if (result && typeof result === "object" && "chosenBranch" in result) {
          chosenBranches[slug] = (result as { chosenBranch: string }).chosenBranch;
        } else if (result && typeof result === "object" && "matched" in result) {
          chosenBranches[slug] = (result as { matched: string }).matched;
        }
      }

      // The run ID is not a job ID: the UI fetches a step's logs by its job.
      const stepJobIds = buildStepJobIdMap(await jobsOf(runId));

      const steps = Object.entries(run.stepStatuses).map(([slug, status]) => {
        const stepDef = wf?.steps[slug];
        const entry: RunStepDescription = {
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
        if (includeResults && slug in run.stepResults) entry.result = run.stepResults[slug];
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

      return {
        runId,
        workflowName: run.workflowName,
        status: run.status,
        ...(run.failureReason ? { failureReason: run.failureReason } : {}),
        trigger: wf?.trigger ?? null,
        chosenBranches,
        steps,
      };
    },

    async stepLogs(runId) {
      const jobs = await jobsOf(runId);
      if (jobs.length === 0) return null;
      const steps = await Promise.all(
        jobs.map(async (s) => {
          const jobLogs = await stepsQueue.getJobLogs(s.id);
          return { slug: s.stepSlug, type: s.stepDef.type, status: s.state, logs: jobLogs.logs, count: jobLogs.count };
        }),
      );
      return { runId, steps };
    },

    async remove(runId) {
      const run = dagRunStore.get(runId);
      const jobs = await jobsOf(runId);
      if (jobs.length === 0 && !run) return null;

      // removeJobs handles every state in one batch: live jobs, DLQ jobs, and
      // completed jobs (requeued and removed under one queue pause so the
      // worker cannot re-run them). A run parked on a signal whose jobs have
      // all completed is purged too, so its jobs do not resurface after a restart.
      const cancelled = await stepsQueue.removeJobs(jobs.map((d) => d.id));
      // Clients drop the whole job group, whatever each job's prior state.
      for (const d of jobs) deps.broadcast({ type: "job_removed", jobId: d.id });
      forget(new Map([[runId, run?.workflowName]]));

      log.info(`Cancelled workflow run ${runId} (${cancelled.length}/${jobs.length} jobs removed)`);
      return { cancelled, total: jobs.length };
    },

    cleanDecision(runId, cleanType) {
      const run = dagRunStore.get(runId);
      if (!run) return "default";
      if (dagRunStore.isActiveRunStatus(run.status)) return "keep";
      return run.status === cleanType ? "remove" : "keep";
    },

    statuses() {
      return dagRunStore.getAll().map((run) => ({ runId: run.id, status: run.status }));
    },

    dispose() {
      signalTimers.cleanup();
      uninstallHumanTasks?.();
    },
  };
}
