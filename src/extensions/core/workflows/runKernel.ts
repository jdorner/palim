/**
 * Run kernel - the pure transition rules of a DAG workflow run.
 *
 * {@link advance} takes a run's state, its workflow definition and one event
 * (a step completed, a control-flow node was evaluated, a signal arrived, a
 * step failed, ...) and returns a {@link RunPatch} of state changes plus a list
 * of {@link RunEffect}s for the caller to execute: dispatch a job, evaluate a
 * control-flow node, register a wait, broadcast, log. It performs no I/O.
 *
 * All graph rules of a run live here: the join barrier, dead-branch
 * propagation, branch choice, iterator/aggregator cycling, the fail-fast sweep
 * and run completion. The coordinator (`dagCoordinator.ts`) is the shell that
 * loads the run, applies the patch and executes the effects.
 *
 * @module
 */

import type { WorkflowWebSocketEvent } from "@shared/workflows";
import { edgeId, type TopologyEdge, type WorkflowTopology } from "@shared/workflowTopology";
import { type CaseStepResult, describeControlFlowStep, type IfStepResult } from "./controlFlowEvaluation";
import type { DagWorkflowRun } from "./dagRunStore";
import { definitionTopology } from "./definitionTopology";
import type { DagAggregatorStep, DagCaseStep, DagIfStep, DagIteratorStep, DagWorkflowDefinition } from "./schemas";
import { DAG_CF_TYPES } from "./schemas";

/** Run status values for a DAG workflow execution. */
export type DagRunStatus = "running" | "waiting-signal" | "completed" | "failed";

/**
 * Whether a run status represents an active (non-terminal) execution.
 *
 * Both `running` and `waiting-signal` are active: the run is still in progress,
 * it just may be paused on a `waitFor` node. Only `completed` and `failed` are
 * terminal. Coordinator control-flow guards use this to decide whether to keep
 * advancing the graph, so a run paused on one branch does not freeze other
 * branches that are still executing.
 *
 * @param status - The run status to test
 * @returns true when the run is still in progress (running or waiting-signal)
 */
export function isActiveRunStatus(status: DagRunStatus): boolean {
  return status === "running" || status === "waiting-signal";
}

/** State of a single edge in the DAG during execution. */
export type EdgeState = "pending" | "satisfied" | "dead";

/**
 * Status of a single step in the DAG during execution.
 *
 * `waiting-signal` marks a `waitFor` node that has registered its signal and is
 * paused pending delivery (or timeout). It is a non-terminal, non-running state:
 * the step is neither actively executing a job nor finished.
 */
export type StepStatus = "pending" | "running" | "waiting-signal" | "completed" | "failed" | "dead";

/**
 * Join-barrier verdict for a step, derived from the states of its incoming edges.
 *
 * - `"waiting"`: at least one incoming edge is unresolved (pending or unknown)
 * - `"dead"`: every incoming edge is resolved and none is satisfied
 * - `"ready"`: every incoming edge is resolved and at least one is satisfied
 */
export type JoinVerdict = "waiting" | "dead" | "ready";

/**
 * Applies the join barrier to a step's incoming edges.
 *
 * This is the single readiness rule of the DAG engine: a step may run once all
 * incoming edges are resolved (`satisfied` or `dead`) and at least one is
 * `satisfied`; if all are `dead`, the step is unreachable.
 *
 * An empty edge list yields `"dead"` (nothing can satisfy it); callers handle
 * root steps separately.
 *
 * @param edgeStates - Per-run edge states keyed by edge ID
 * @param incomingEdgeIds - IDs of the step's incoming edges
 * @returns The join verdict for the step
 */
export function classifyIncomingEdges(
  edgeStates: Readonly<Record<string, EdgeState>>,
  incomingEdgeIds: readonly string[],
): JoinVerdict {
  let hasSatisfied = false;
  for (const eid of incomingEdgeIds) {
    const state = edgeStates[eid];
    if (state === "satisfied") {
      hasSatisfied = true;
    } else if (state !== "dead") {
      // pending or unknown: not resolved yet
      return "waiting";
    }
  }
  return hasSatisfied ? "ready" : "dead";
}

/** The part of a run the kernel reads. */
export type RunState = Pick<
  DagWorkflowRun,
  "id" | "workflowName" | "status" | "stepStatuses" | "edgeStates" | "stepResults"
>;

/** Iteration state stored as the iterator's step result. */
export interface IterationState {
  /** The full array of items to iterate over. */
  items: unknown[];
  /** Zero-based index of the current iteration. */
  cursor: number;
  /** Collected results from completed iterations. */
  iterationResults: unknown[];
  /** The variable name for the current item in templates. */
  as: string;
}

/** Something that happened to a run. Every event except `runStarted` names the step it concerns. */
export type RunEvent =
  /** A queue job finished with a result. */
  | { type: "stepCompleted"; slug: string; result: unknown }
  /** A waitFor/humanTask node received its signal. `otherSignalsPending`: another wait of the run is still open. */
  | { type: "signalReceived"; slug: string; payload: unknown; otherSignalsPending: boolean }
  /** An `if` node's condition was resolved and evaluated by the shell. */
  | { type: "ifEvaluated"; slug: string; condition: boolean; value: string | null }
  /** A `case` node's match expression was resolved by the shell. */
  | { type: "caseEvaluated"; slug: string; value: string }
  /** An `iterator` node's items were resolved and parsed by the shell. */
  | { type: "iteratorEvaluated"; slug: string; items: unknown[] }
  /** A new run starts: every root step is activated. */
  | { type: "runStarted" }
  /** The shell created a waitFor/humanTask node's signal: the branch pauses, announcing what it waits for. */
  | { type: "waitRegistered"; slug: string; event: string; inputSchema: WaitInputSchema }
  /** A step failed; the run fails fast. */
  | { type: "stepFailed"; slug: string; reason: string };

/** The input schema announced with a waiting step. */
export type WaitInputSchema = Extract<WorkflowWebSocketEvent, { type: "workflow_step_waiting" }>["inputSchema"];

/** Something the shell must do after applying the patch, in order. */
export type RunEffect =
  /** Enqueue the step as a job (it is already marked running). */
  | { type: "dispatch"; slug: string }
  /** Resolve an if/case/iterator node's templates and feed back the matching `*Evaluated` event. */
  | { type: "evaluate"; slug: string }
  /** Register a waitFor/humanTask node's signal (it is already marked running). */
  | { type: "register"; slug: string }
  | { type: "broadcast"; event: WorkflowWebSocketEvent }
  | { type: "log"; level: "debug" | "info" | "warn" | "error"; message: string };

/** State changes to apply to a run, key by key (applied by `dagRunStore.applyPatch`). */
export interface RunPatch {
  /** New run status, when it changed. */
  status?: DagRunStatus;
  /** Failure reason stored with `status` (null clears it). */
  failureReason?: string | null;
  stepStatuses: Record<string, StepStatus>;
  edgeStates: Record<string, EdgeState>;
  stepResults: Record<string, unknown>;
}

/** The outcome of one event. */
export interface Transition {
  patch: RunPatch;
  effects: RunEffect[];
}

/** Effects that start work; dropped when the run fails within the same transition. */
const WORK_EFFECTS = new Set<RunEffect["type"]>(["dispatch", "evaluate", "register"]);

/**
 * Applies one event to a run.
 *
 * Events on a run that is no longer active (completed or failed) change
 * nothing. A run whose definition is gone fails. When the run fails during the
 * transition, work effects emitted before the failure are dropped and every
 * open step is swept to `dead`.
 *
 * @param run - The current run state
 * @param definition - The run's workflow definition, or undefined when it no longer exists
 * @param event - The event to apply
 * @returns The patch to apply and the effects to execute, in order
 */
export function advance(run: RunState, definition: DagWorkflowDefinition | undefined, event: RunEvent): Transition {
  const t = new TransitionBuilder(run);
  const slug = "slug" in event ? event.slug : null;
  if (!t.active) {
    const subject = slug === null ? "" : ` of step "${slug}"`;
    t.log("warn", `DAG coordinator: run ${run.id} is "${run.status}", ignoring ${event.type}${subject}`);
  } else if (event.type === "stepFailed") {
    t.fail(event.slug, event.reason);
  } else if (!definition) {
    t.fail(slug, `Workflow definition "${run.workflowName}" no longer available`);
  } else {
    new GraphRules(t, definition).apply(event);
  }
  return t.result();
}

/**
 * Picks the branch a `case` node takes when no path matched.
 *
 * `default` names the fallback branch key (a path key or a key of its own).
 * An edge with the literal branch `"default"` is the fallback when the named
 * key has no edge or no `default` is declared, so definitions written for the
 * earlier engine (which always routed to `"default"`) keep working.
 *
 * @param stepDef - The case step definition
 * @param outEdges - The case node's outgoing edges
 * @returns The fallback branch key, or null when the node has no fallback
 */
export function caseFallbackBranch(stepDef: DagCaseStep, outEdges: readonly TopologyEdge[]): string | null {
  const hasEdge = (branch: string) => outEdges.some((e) => e.branch === branch);
  if (stepDef.default && hasEdge(stepDef.default)) return stepDef.default;
  if (hasEdge("default")) return "default";
  return stepDef.default ?? null;
}

/** Working copy of a run's state that records every change as a patch. */
class TransitionBuilder {
  readonly runId: string;
  status: DagRunStatus;
  readonly statuses: Record<string, StepStatus>;
  readonly edges: Record<string, EdgeState>;
  readonly results: Record<string, unknown>;
  private readonly patch: RunPatch = { stepStatuses: {}, edgeStates: {}, stepResults: {} };
  private effects: RunEffect[] = [];

  constructor(run: RunState) {
    this.runId = run.id;
    this.status = run.status;
    this.statuses = { ...run.stepStatuses };
    this.edges = { ...run.edgeStates };
    this.results = { ...run.stepResults };
  }

  get active(): boolean {
    return isActiveRunStatus(this.status);
  }

  setRunStatus(status: DagRunStatus, reason: string | null = null): void {
    this.status = status;
    this.patch.status = status;
    this.patch.failureReason = reason;
  }

  setStatus(slug: string, status: StepStatus): void {
    this.statuses[slug] = status;
    this.patch.stepStatuses[slug] = status;
  }

  setEdge(edge: TopologyEdge, state: EdgeState): void {
    const id = edgeId(edge.from, edge.to, edge.branch);
    this.edges[id] = state;
    this.patch.edgeStates[id] = state;
  }

  setResult(slug: string, value: unknown): void {
    this.results[slug] = value;
    this.patch.stepResults[slug] = value;
  }

  effect(effect: RunEffect): void {
    this.effects.push(effect);
  }

  broadcast(event: WorkflowWebSocketEvent): void {
    this.effects.push({ type: "broadcast", event });
  }

  log(level: "debug" | "info" | "warn" | "error", message: string): void {
    this.effects.push({ type: "log", level, message });
  }

  /**
   * Fails the run at a step (or, with `null`, as a whole): drops pending work
   * and sweeps every open step to dead.
   */
  fail(slug: string | null, reason: string): void {
    this.log("error", `DAG run ${this.runId} failed${slug === null ? "" : ` at step "${slug}"`}: ${reason}`);
    this.effects = this.effects.filter((e) => !WORK_EFFECTS.has(e.type));
    if (slug !== null) this.setStatus(slug, "failed");
    this.setRunStatus("failed", reason);
    this.broadcast({ type: "workflow_failed", workflowRunId: this.runId, failedStep: slug ?? "", error: reason });
    for (const [s, status] of Object.entries(this.statuses)) {
      if (status === "pending" || status === "running" || status === "waiting-signal") {
        this.setStatus(s, "dead");
        this.broadcast({ type: "workflow_step_dead", workflowRunId: this.runId, stepSlug: s });
      }
    }
  }

  result(): Transition {
    return { patch: this.patch, effects: this.effects };
  }
}

/** The graph rules, applied to one transition. */
class GraphRules {
  private readonly topology: WorkflowTopology;

  constructor(
    private readonly t: TransitionBuilder,
    private readonly definition: DagWorkflowDefinition,
  ) {
    this.topology = definitionTopology(definition);
  }

  apply(event: Exclude<RunEvent, { type: "stepFailed" }>): void {
    const { t } = this;
    switch (event.type) {
      case "stepCompleted":
        this.resolveSuccessors(this.complete(event.slug, event.result));
        break;
      case "signalReceived": {
        const out = this.complete(event.slug, event.payload);
        t.setRunStatus(event.otherSignalsPending ? "waiting-signal" : "running");
        this.resolveSuccessors(out);
        break;
      }
      case "ifEvaluated":
        this.ifEvaluated(event.slug, event.condition, event.value);
        break;
      case "caseEvaluated":
        this.caseEvaluated(event.slug, event.value);
        break;
      case "iteratorEvaluated":
        this.iteratorEvaluated(event.slug, event.items);
        break;
      case "runStarted":
        for (const root of this.topology.roots) {
          if (!t.active) break;
          this.activate(root);
        }
        break;
      case "waitRegistered":
        this.waitRegistered(event.slug, event.event, event.inputSchema);
        break;
    }
    this.checkCompletion();
  }

  /** Starts a step whose join barrier is released. Inline types never reach the queue. */
  private activate(slug: string): void {
    const stepDef = this.definition.steps[slug];
    if (!stepDef) return;
    this.t.setStatus(slug, "running");
    if (DAG_CF_TYPES.has(stepDef.type)) this.t.effect({ type: "evaluate", slug });
    else if (stepDef.type === "waitFor" || stepDef.type === "humanTask") this.t.effect({ type: "register", slug });
    else if (stepDef.type === "aggregator") this.aggregate(slug, stepDef as DagAggregatorStep);
    else this.t.effect({ type: "dispatch", slug });
  }

  /**
   * Re-checks the targets of freshly resolved edges against the join barrier:
   * all incoming edges resolved and one satisfied starts the step; all dead
   * marks it dead.
   */
  private resolveSuccessors(resolved: readonly TopologyEdge[]): void {
    const { t, topology } = this;
    for (const slug of new Set(resolved.map((e) => e.to))) {
      if (!t.active) return;
      const incoming = topology.incoming(slug);
      if (t.statuses[slug] !== "pending" || incoming.length === 0) continue;
      const verdict = classifyIncomingEdges(
        t.edges,
        incoming.map((e) => edgeId(e.from, e.to, e.branch)),
      );
      if (verdict === "dead") this.markDead(slug);
      else if (verdict === "ready") this.activate(slug);
    }
  }

  /** Marks an unreachable step dead and propagates through its outgoing edges. */
  private markDead(slug: string): void {
    const { t } = this;
    t.setStatus(slug, "dead");
    t.broadcast({ type: "workflow_step_dead", workflowRunId: t.runId, stepSlug: slug });
    t.log("debug", `DAG coordinator: step "${slug}" in run ${t.runId} is dead (all incoming edges dead)`);
    const out = this.topology.outgoing(slug);
    for (const edge of out) t.setEdge(edge, "dead");
    this.resolveSuccessors(out);
  }

  /**
   * Completes a step: stores its result and resolves its outgoing edges.
   *
   * @param taken - Which outgoing edges are satisfied (the others die); all when omitted
   * @returns The step's outgoing edges
   */
  private complete(slug: string, result: unknown, taken?: (edge: TopologyEdge) => boolean): readonly TopologyEdge[] {
    const { t } = this;
    t.setResult(slug, result);
    t.setStatus(slug, "completed");
    const out = this.topology.outgoing(slug);
    for (const edge of out) t.setEdge(edge, !taken || taken(edge) ? "satisfied" : "dead");
    return out;
  }

  /**
   * Pauses a waitFor/humanTask branch once its signal exists: the step and the
   * run wait. Ignored unless the step is still running (it was activated and
   * not swept since); the shell then withdraws the signal.
   */
  private waitRegistered(slug: string, event: string, inputSchema: WaitInputSchema): void {
    const { t } = this;
    if (!this.definition.steps[slug] || t.statuses[slug] !== "running") {
      t.log("warn", `DAG coordinator: step "${slug}" in run ${t.runId} is "${t.statuses[slug]}", not waiting`);
      return;
    }
    t.setStatus(slug, "waiting-signal");
    t.setRunStatus("waiting-signal");
    t.broadcast({ type: "workflow_step_waiting", workflowRunId: t.runId, stepSlug: slug, event, inputSchema });
  }

  /** Broadcasts the completion of an inline node (no job, so the run id stands in for it). */
  private announce(
    slug: string,
    extra: Partial<Extract<WorkflowWebSocketEvent, { type: "workflow_step_completed" }>> = {},
  ): void {
    this.t.broadcast({
      type: "workflow_step_completed",
      workflowRunId: this.t.runId,
      stepSlug: slug,
      jobId: this.t.runId,
      ...extra,
    });
  }

  private ifEvaluated(slug: string, condition: boolean, value: string | null): void {
    const stepDef = this.definition.steps[slug] as DagIfStep;
    const chosenBranch = condition ? "then" : "else";
    const result: IfStepResult = { condition, chosenBranch, value };
    const out = this.complete(slug, result, (e) => e.branch === chosenBranch);
    this.announce(slug, { chosenBranch, evaluation: describeControlFlowStep(stepDef, result) });
    this.t.log(
      "info",
      `DAG if node "${slug}" in run ${this.t.runId}: condition=${condition}, branch="${chosenBranch}"`,
    );
    this.resolveSuccessors(out);
  }

  private caseEvaluated(slug: string, value: string): void {
    const stepDef = this.definition.steps[slug] as DagCaseStep;
    const matched = stepDef.paths.find((key) => key === value) ?? null;
    const branch = matched ?? caseFallbackBranch(stepDef, this.topology.outgoing(slug));
    if (branch === null) {
      this.t.fail(
        slug,
        `Case node "${slug}" - no path matched "${value}" and no default defined. Paths: [${stepDef.paths.join(", ")}]`,
      );
      return;
    }
    const result: CaseStepResult = { matched: branch, value, fallback: matched === null };
    const out = this.complete(slug, result, (e) => e.branch === branch);
    this.announce(slug, { chosenBranch: branch, evaluation: describeControlFlowStep(stepDef, result) });
    this.t.log("info", `DAG case node "${slug}" in run ${this.t.runId}: matched="${branch}"`);
    this.resolveSuccessors(out);
  }

  /** Starts the first iteration, or completes the aggregator at once for an empty array. */
  private iteratorEvaluated(slug: string, items: unknown[]): void {
    const { t } = this;
    const stepDef = this.definition.steps[slug] as DagIteratorStep;
    const state: IterationState = { items, cursor: 0, iterationResults: [], as: stepDef.as ?? "item" };

    if (items.length > 0) {
      const out = this.complete(slug, state, (e) => e.branch === "each");
      this.announce(slug);
      t.log("info", `Iterator "${slug}" in run ${t.runId}: ${items.length} items, starting iteration 0`);
      this.resolveSuccessors(out);
      return;
    }

    // Empty: the body never runs. Its edges stay pending, like the body steps.
    t.setResult(slug, state);
    t.setStatus(slug, "completed");
    this.announce(slug);
    t.log("info", `Iterator "${slug}" in run ${t.runId}: empty items array, short-circuiting`);
    const aggSlug = this.topology.aggregatorOf(slug);
    if (aggSlug) {
      const out = this.complete(aggSlug, { results: [], totalItems: 0, succeeded: 0, failed: 0 });
      this.announce(aggSlug);
      this.resolveSuccessors(out);
    }
  }

  /** Collects one iteration, then either re-runs the body or completes the aggregator. */
  private aggregate(slug: string, stepDef: DagAggregatorStep): void {
    const { t, topology } = this;
    const iterSlug = stepDef.iterator;
    const prev = t.results[iterSlug] as IterationState | undefined;
    if (!prev) {
      t.fail(slug, `Aggregator "${slug}" cannot read iterator state from "${iterSlug}"`);
      return;
    }

    const body = topology.iteratorBody(iterSlug);
    const iterationResult: Record<string, unknown> = {};
    for (const s of body?.terminals ?? []) iterationResult[s] = t.results[s];
    const state: IterationState = {
      ...prev,
      cursor: prev.cursor + 1,
      iterationResults: [...prev.iterationResults, iterationResult],
    };
    t.setResult(iterSlug, state);

    if (state.cursor < state.items.length) {
      t.log(
        "info",
        `Aggregator "${slug}" in run ${t.runId}: iteration ${state.cursor - 1} complete, advancing to ${state.cursor}/${state.items.length}`,
      );
      // Reset the body and the aggregator, then re-satisfy the `each` edges.
      for (const s of body?.steps ?? []) t.setStatus(s, "pending");
      for (const edge of body?.edges ?? []) t.setEdge(edge, "pending");
      t.setStatus(slug, "pending");
      const each = topology.outgoing(iterSlug).filter((e) => e.branch === "each");
      for (const edge of each) t.setEdge(edge, "satisfied");
      this.resolveSuccessors(each);
      return;
    }

    const out = this.complete(slug, {
      results: state.iterationResults,
      totalItems: state.items.length,
      succeeded: state.iterationResults.length,
      failed: 0,
    });
    this.announce(slug);
    t.log("info", `Aggregator "${slug}" in run ${t.runId}: all ${state.items.length} iterations complete`);
    this.resolveSuccessors(out);
  }

  /**
   * A run is complete when every terminal step is completed or dead. All
   * terminals may be dead: a branch without edges ends the run normally.
   */
  private checkCompletion(): void {
    const { t } = this;
    if (!t.active) return;
    if (!this.topology.terminals.every((s) => t.statuses[s] === "completed" || t.statuses[s] === "dead")) return;
    t.setRunStatus("completed");
    t.broadcast({ type: "workflow_completed", workflowRunId: t.runId });
    t.log("info", `DAG workflow run ${t.runId} completed`);
  }
}
