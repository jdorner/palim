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
import { cancelReason, isCancelReason } from "@shared/jobs";
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
  "getAllJobs" | "cancelJob" | "removeJobs" | "getJobLogs" | "appendJobLog" | "onEvent"
>;

/** Job states in which a step job will still be processed (and report back through a queue event). */
const LIVE_JOB_STATES: ReadonlySet<string> = new Set([
  "waiting",
  "prioritized",
  "waiting-children",
  "delayed",
  "active",
]);

/** Why fail-fast cancels a failed run's other in-flight step jobs. */
const RUN_FAILED_CANCEL_REASON = cancelReason({ cause: "the workflow run failed" });

/** Why deleting a run cancels its active step jobs. */
const RUN_DELETED_CANCEL_REASON = cancelReason({ cause: "the workflow run was deleted" });

/** How long {@link WorkflowRuns.remove} waits for cancelled active jobs to end before removing them. */
const CANCEL_SETTLE_TIMEOUT_MS = 5000;

/** Poll interval while waiting for cancelled jobs to end. */
const CANCEL_SETTLE_POLL_MS = 50;

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
   * Reads the execution logs of a run's steps in run order. Steps that ran as
   * jobs carry their job logs; steps the coordinator handled inline (human
   * tasks, signal waits, control flow, dead branches) carry their run-record
   * status and, when known, a synthesized line with their error or decision.
   *
   * @param runId - The run
   * @returns The logs, or null when neither the run record nor any job exists
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
   * Fails the runs a server restart interrupted. bunqueue's startup recovery
   * moves a job that was active at shutdown to the DLQ (or retries it)
   * without emitting a queue event, and steps that ran inline (control flow,
   * wait registration) leave nothing to resume. Such a run stays `running`
   * forever. A step counts as interrupted when it is `running` in an active
   * run last written before `writtenBefore` and its newest job is not queued
   * or active any more (or it has no job at all). Its run fails fast through
   * the kernel like any other step failure.
   *
   * @param writtenBefore - Only runs last updated before this epoch ms are
   *   checked (default: this process's start, so runs this process is
   *   dispatching are never touched)
   * @returns Number of runs failed
   */
  recoverInterrupted(writtenBefore?: number): Promise<number>;
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
      await stepsQueue.cancelJob(jobId, RUN_FAILED_CANCEL_REASON);
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

  /** Announces a failed attempt of a step job to connected clients. */
  const broadcastStepFailed = (d: ReturnType<typeof stepData>, error: string) =>
    deps.broadcast({
      type: "workflow_step_failed",
      workflowRunId: d.workflowRunId,
      stepSlug: d.stepSlug,
      jobId: d.id,
      error,
    });

  /** Fails the run of a terminally failed step job and tells other extensions. */
  async function failRunOfJob(d: ReturnType<typeof stepData>, error: string): Promise<void> {
    // Fail-fast: the coordinator cancels the run's in-flight jobs.
    await handleDagStepFailure(d.workflowRunId, d.stepSlug, error, coordinatorDeps);
    // A cancelled step was stopped on purpose: no error for others to analyze.
    if (isCancelReason(error)) return;
    // Domain event for cross-extension consumers (e.g. error-analyzer).
    deps.emitEvent({
      type: "workflow:step_failed",
      context: {
        source: "workflows",
        id: d.workflowRunId,
        workflowRunId: d.workflowRunId,
        workflowName: d.workflowName,
        stepSlug: d.stepSlug,
        jobId: d.id,
        error,
      },
    });
  }

  stepsQueue.onEvent("failed", async ({ failedReason, job }) => {
    if (!job) return;
    const d = stepData(job);
    // The run was deleted while this job ran (its cancellation ended it): nothing to fail.
    if (!dagRunStore.get(d.workflowRunId)) return;
    broadcastStepFailed(d, failedReason);
    // Only fail the run once the job is truly failed (not a retry delay).
    if (d.state !== "failed") return;
    await failRunOfJob(d, failedReason);
  });

  /**
   * Waits until none of the given jobs is active any more, or the timeout passes.
   *
   * @param runId - The run the jobs belong to
   * @param ids - The cancelled job IDs
   * @returns The run's jobs after waiting
   */
  async function settle(runId: string, ids: ReadonlySet<string>): Promise<Awaited<ReturnType<typeof jobsOf>>> {
    const deadline = Date.now() + CANCEL_SETTLE_TIMEOUT_MS;
    for (;;) {
      const jobs = await jobsOf(runId);
      const pending = jobs.filter((d) => ids.has(d.id) && d.state === "active");
      if (pending.length === 0) return jobs;
      if (Date.now() >= deadline) {
        log.warn(`Run ${runId}: ${pending.length} cancelled job(s) still active after ${CANCEL_SETTLE_TIMEOUT_MS} ms`);
        return jobs;
      }
      await Bun.sleep(CANCEL_SETTLE_POLL_MS);
    }
  }

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
      const run = dagRunStore.get(runId);
      const jobs = (await jobsOf(runId)).sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
      if (jobs.length === 0 && !run) return null;

      const jobEntry = async (s: (typeof jobs)[number]): Promise<RunStepLogs["steps"][number]> => {
        const jobLogs = await stepsQueue.getJobLogs(s.id);
        return { slug: s.stepSlug, type: s.stepDef.type, status: s.state, logs: jobLogs.logs, count: jobLogs.count };
      };

      const wf = run ? deps.getWorkflowDefinition(run.workflowName) : undefined;
      const entries: Promise<RunStepLogs["steps"][number]>[] = [];
      const listed = new Set<string>();
      for (const [slug, status] of Object.entries(run?.stepStatuses ?? {})) {
        listed.add(slug);
        const stepJobs = jobs.filter((j) => j.stepSlug === slug);
        if (stepJobs.length > 0) {
          entries.push(...stepJobs.map(jobEntry));
          continue;
        }
        // No job: the coordinator handled the step inline, so the run record
        // is its only trace (see `describe`).
        const stepDef = wf?.steps[slug];
        const logs = inlineStepLogs(status, describeControlFlowStep(stepDef, run?.stepResults[slug]), run);
        entries.push(Promise.resolve({ slug, type: stepDef?.type ?? "unknown", status, logs, count: logs.length }));
      }
      // Jobs of steps the run record does not know (the record is gone).
      entries.push(...jobs.filter((j) => !listed.has(j.stepSlug)).map(jobEntry));

      return { runId, steps: await Promise.all(entries) };
    },

    async remove(runId) {
      const run = dagRunStore.get(runId);
      let jobs = await jobsOf(runId);
      if (jobs.length === 0 && !run) return null;

      // An active job cannot be removed: cancel it (aborting its LLM request)
      // and wait for it to end, so it is removed below instead of lingering.
      const active = jobs.filter((d) => d.state === "active").map((d) => d.id);
      if (active.length > 0) {
        for (const id of active) await stepsQueue.cancelJob(id, RUN_DELETED_CANCEL_REASON);
        jobs = await settle(runId, new Set(active));
      }

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

    async recoverInterrupted(writtenBefore = performance.timeOrigin) {
      // Snapshot the candidates before the first await: a run started while
      // the queue is scanned is written by this process and must not match.
      const candidates = dagRunStore
        .getAll()
        .filter(
          (run) =>
            dagRunStore.isActiveRunStatus(run.status) &&
            run.updatedAt < writtenBefore &&
            Object.values(run.stepStatuses).includes("running"),
        );
      if (candidates.length === 0) return 0;

      const allJobs = await stepsQueue.getAllJobs();
      let failedRuns = 0;
      for (const run of candidates) {
        const jobs = runJobs(allJobs, run.id);
        for (const [slug, status] of Object.entries(run.stepStatuses)) {
          if (status !== "running") continue;
          // An iterator body has one job per iteration: the newest one counts.
          const job = jobs
            .filter((j) => j.stepSlug === slug)
            .reduce<(typeof jobs)[number] | undefined>(
              (newest, j) => (!newest || (j.timestamp ?? 0) >= (newest.timestamp ?? 0) ? j : newest),
              undefined,
            );
          if (job && LIVE_JOB_STATES.has(job.state)) continue;

          const reason = job
            ? `Step was interrupted by a server restart (job ${job.id} is ${job.state})`
            : "Step was interrupted by a server restart";
          log.warn(`Failing workflow run ${run.id} at step "${slug}": ${reason}`);
          if (job) {
            // The step panel shows a job step's logs: end them the way the worker
            // ends a failed step's, or they stop mid-step without a reason.
            try {
              await stepsQueue.appendJobLog(job.id, `Step "${slug}" failed: ${reason}`);
            } catch (err) {
              log.warn(`Could not log the interruption of step "${slug}" to job ${job.id}:`, err);
            }
            broadcastStepFailed(job, reason);
            await failRunOfJob(job, reason);
          } else {
            await handleDagStepFailure(run.id, slug, reason, coordinatorDeps);
          }
          failedRuns++;
          // The run failed fast: its other open steps are swept and cancelled.
          break;
        }
      }
      return failedRuns;
    },

    dispose() {
      signalTimers.cleanup();
      uninstallHumanTasks?.();
    },
  };
}

/**
 * Synthesized log lines for a step that ran without a job.
 *
 * @param status - The step's run-record status
 * @param evaluation - The control-flow decision, for `if` and `case` nodes
 * @param run - The run record (for the failure reason and its time)
 * @returns The lines; empty when the record holds nothing to report
 */
function inlineStepLogs(
  status: string,
  evaluation: ControlFlowEvaluation | undefined,
  run: dagRunStore.DagWorkflowRun | null,
): RunStepLogs["steps"][number]["logs"] {
  const timestamp = run?.updatedAt ?? 0;
  if (evaluation) {
    const value = evaluation.value === undefined ? "" : ` (value: ${JSON.stringify(evaluation.value)})`;
    const fallback = evaluation.fallback ? ", fallback" : "";
    return [{ message: `${evaluation.expression}${value} -> branch "${evaluation.branch}"${fallback}`, timestamp }];
  }
  // A step that failed inline: the run's failure reason is its only error record.
  if (status === "failed" && run?.failureReason) return [{ message: `Error: ${run.failureReason}`, timestamp }];
  return [];
}
