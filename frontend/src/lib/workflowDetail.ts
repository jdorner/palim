/**
 * Data model for the workflow detail page: the normalized workflow shape,
 * conversion from the API response, and applying live run events.
 */
import type { OutputSchemaShorthand, WorkflowWebSocketEvent } from "$shared/workflows";
import type { OutputSchemas } from "./templateScope";
import { nextStepId } from "./workflowDraft";

export interface StepDef {
  /**
   * Stable synthetic node identity for the editor graph, independent of the
   * user-editable slug. Minted client-side on load/add and never persisted.
   */
  id: string;
  slug: string;
  type: string;
  prompt?: string;
  tools?: string[];
  skills?: string[];
  url?: string;
  method?: string;
  body?: string;
  input?: string;
  output?: string;
}

export interface WorkflowWarning {
  stepSlug: string;
  field: string;
  message: string;
}

/**
 * Formats a warning's location as `<slug>.<field>`, showing the reserved
 * `__trigger__` slug (used for trigger warnings) as `trigger`.
 *
 * @param warning - The warning to locate
 * @returns The display location, e.g. `fetch.url` or `trigger.ref`
 */
export function warningLocation(warning: WorkflowWarning): string {
  const slug = warning.stepSlug === "__trigger__" ? "trigger" : warning.stepSlug;
  return `${slug}.${warning.field}`;
}

export interface WorkflowRunSummary {
  runId: string;
  status: string;
  startedAt: number;
  completedAt?: number;
  steps: Array<{ slug: string; status: string; jobId: string }>;
}

export interface WorkflowTrigger {
  type: string;
  ref?: string;
  /** Hand-authored payload shape, when declared. */
  outputSchema?: OutputSchemaShorthand;
}

export interface WorkflowDetail {
  name: string;
  description?: string;
  trigger: WorkflowTrigger;
  enabled?: boolean;
  /** DAG steps normalized to an array with slug + synthetic id (array editor). */
  steps: StepDef[];
  /**
   * DAG edges connecting steps by SYNTHETIC ID (not slug). Converted from the
   * slug-based API representation in `normalizeWorkflow` and back to slugs in
   * `serializeWorkflowDraft`. Id-based edges survive slug edits/collisions.
   */
  edges: Array<{ from: string; to: string; branch?: string }>;
  warnings: WorkflowWarning[];
  outputSchemas?: OutputSchemas;
  runs: WorkflowRunSummary[];
}

/**
 * Normalizes a DAG workflow API response (steps map + edges array) into the
 * page's internal shape (steps array with slug + id-based edges array).
 *
 * @param raw - Parsed JSON from `GET /ext/workflows/:name`.
 * @returns The normalized workflow.
 */
export function normalizeWorkflow(raw: Record<string, unknown>): WorkflowDetail {
  const stepsMap = (raw.steps ?? {}) as Record<string, Record<string, unknown>>;
  const stepsArray = Object.entries(stepsMap).map(([slug, s]) => ({ id: nextStepId(), slug, ...s })) as StepDef[];

  // Persisted edges reference steps by slug. Convert them to the internal
  // id-based representation so the editor tracks connections by stable identity
  // (slugs are user-editable and can collide/empty mid-edit). Slugs are unique
  // in a saved definition, so this mapping is unambiguous at load time.
  const slugToId = new Map(stepsArray.map((s) => [s.slug, s.id]));
  const rawEdges = (raw.edges ?? []) as Array<{ from: string; to: string; branch?: string }>;
  const edges = rawEdges
    .map((e) => {
      const from = slugToId.get(e.from);
      const to = slugToId.get(e.to);
      if (from === undefined || to === undefined) return null;
      return e.branch !== undefined ? { from, to, branch: e.branch } : { from, to };
    })
    .filter((e): e is { from: string; to: string; branch?: string } => e !== null);

  return {
    ...(raw as Omit<WorkflowDetail, "steps" | "edges">),
    steps: stepsArray,
    edges,
  };
}

/**
 * Returns `workflow` with `runPatch` merged into run `runId`, optionally also
 * merging `step.patch` into the matching step of that run.
 */
function updateRun(
  workflow: WorkflowDetail,
  runId: string,
  runPatch: Partial<WorkflowRunSummary>,
  step?: { slug: string; patch: Partial<WorkflowRunSummary["steps"][number]> },
): WorkflowDetail {
  return {
    ...workflow,
    runs: workflow.runs.map((r) => {
      if (r.runId !== runId) return r;
      const updated = { ...r, ...runPatch };
      if (step) {
        updated.steps = r.steps.map((s) => (s.slug === step.slug ? { ...s, ...step.patch } : s));
      }
      return updated;
    }),
  };
}

/**
 * Applies a live workflow WebSocket event to the page's run list.
 *
 * @param workflow - Current workflow state.
 * @param msg - The incoming event.
 * @param name - Name of the workflow shown on the page (new runs of other
 *   workflows are ignored; other events are matched by run id).
 * @returns The updated workflow, or the same object if the event is irrelevant.
 */
export function applyWorkflowEvent(
  workflow: WorkflowDetail,
  msg: WorkflowWebSocketEvent,
  name: string,
): WorkflowDetail {
  switch (msg.type) {
    case "workflow_started": {
      if (msg.workflowName !== name) return workflow;
      const newRun: WorkflowRunSummary = {
        runId: msg.workflowRunId,
        status: "queued",
        startedAt: Date.now(),
        steps: msg.steps.map((s) => ({ slug: s.slug, status: "waiting", jobId: s.jobId ?? "" })),
      };
      return { ...workflow, runs: [newRun, ...workflow.runs] };
    }
    case "workflow_step_started":
      return updateRun(
        workflow,
        msg.workflowRunId,
        { status: "running" },
        { slug: msg.stepSlug, patch: { status: "active", jobId: msg.jobId } },
      );
    case "workflow_step_completed":
      return updateRun(workflow, msg.workflowRunId, {}, { slug: msg.stepSlug, patch: { status: "completed" } });
    case "workflow_step_dead":
      // Not-taken branch (or a step swept when the run failed).
      return updateRun(workflow, msg.workflowRunId, {}, { slug: msg.stepSlug, patch: { status: "dead" } });
    case "workflow_step_waiting":
      return updateRun(
        workflow,
        msg.workflowRunId,
        { status: "waiting-signal" },
        { slug: msg.stepSlug, patch: { status: "waiting-signal" } },
      );
    case "workflow_step_resumed":
      return updateRun(
        workflow,
        msg.workflowRunId,
        { status: "running" },
        { slug: msg.stepSlug, patch: { status: "completed" } },
      );
    case "workflow_step_failed":
      return updateRun(
        workflow,
        msg.workflowRunId,
        { status: "failed" },
        { slug: msg.stepSlug, patch: { status: "failed" } },
      );
    case "workflow_completed":
      return updateRun(workflow, msg.workflowRunId, { status: "completed", completedAt: Date.now() });
    case "workflow_failed":
      return updateRun(workflow, msg.workflowRunId, { status: "failed", completedAt: Date.now() });
    case "workflow_run_removed":
      // The run was cancelled or cleaned (its record is gone from the run store).
      // Drop it from the list so the "Runs (N)" count and failed-run entries stay
      // in sync without a manual refetch.
      return { ...workflow, runs: workflow.runs.filter((r) => r.runId !== msg.workflowRunId) };
    default:
      return workflow;
  }
}
