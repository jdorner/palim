import { describe, expect, test } from "bun:test";
import { aggregateStepStatus } from "./utils";
import { applyWorkflowEvent, normalizeWorkflow, type WorkflowDetail } from "./workflowDetail";

describe("normalizeWorkflow", () => {
  test("turns the steps map into an array and rewrites edges to synthetic ids", () => {
    const wf = normalizeWorkflow({
      name: "w",
      trigger: { type: "manual" },
      steps: { a: { type: "agent", prompt: "p" }, b: { type: "agent" } },
      edges: [
        { from: "a", to: "b", branch: "then" },
        { from: "a", to: "missing" },
      ],
      warnings: [],
      runs: [],
    });
    const [a, b] = wf.steps;
    expect(a).toMatchObject({ slug: "a", type: "agent", prompt: "p" });
    expect(a!.id).not.toBe(b!.id);
    expect(wf.edges).toEqual([{ from: a!.id, to: b!.id, branch: "then" }]);
  });
});

describe("applyWorkflowEvent", () => {
  const base = (): WorkflowDetail => ({
    name: "w",
    trigger: { type: "manual" },
    steps: [],
    edges: [],
    warnings: [],
    runs: [
      {
        runId: "r1",
        status: "running",
        startedAt: 0,
        steps: [
          { slug: "a", status: "waiting", jobId: "" },
          { slug: "b", status: "waiting", jobId: "" },
        ],
      },
    ],
  });

  test("prepends runs started for this workflow only", () => {
    const started = {
      type: "workflow_started" as const,
      workflowRunId: "r2",
      steps: [{ slug: "a", type: "agent", jobId: "j" }],
    };
    const mine = applyWorkflowEvent(base(), { ...started, workflowName: "w" }, "w");
    expect(mine.runs[0]).toMatchObject({ runId: "r2", status: "queued", steps: [{ slug: "a", jobId: "j" }] });

    const other = base();
    expect(applyWorkflowEvent(other, { ...started, workflowName: "x" }, "w")).toBe(other);
  });

  test("marks a started step active with its job id", () => {
    const wf = applyWorkflowEvent(
      base(),
      { type: "workflow_step_started", workflowRunId: "r1", stepSlug: "a", jobId: "j1" },
      "w",
    );
    expect(wf.runs[0]!.status).toBe("running");
    expect(wf.runs[0]!.steps[0]).toEqual({ slug: "a", status: "active", jobId: "j1" });
    expect(wf.runs[0]!.steps[1]!.status).toBe("waiting");
  });

  test("tracks waiting and resumed signals", () => {
    let wf = applyWorkflowEvent(
      base(),
      { type: "workflow_step_waiting", workflowRunId: "r1", stepSlug: "b", event: "go" } as never,
      "w",
    );
    expect(wf.runs[0]!.status).toBe("waiting-signal");
    expect(wf.runs[0]!.steps[1]!.status).toBe("waiting-signal");

    wf = applyWorkflowEvent(
      wf,
      { type: "workflow_step_resumed", workflowRunId: "r1", stepSlug: "b", signalEvent: "go" },
      "w",
    );
    expect(wf.runs[0]!.status).toBe("running");
    expect(wf.runs[0]!.steps[1]!.status).toBe("completed");
  });

  test("fails the run and step on step failure", () => {
    const wf = applyWorkflowEvent(
      base(),
      { type: "workflow_step_failed", workflowRunId: "r1", stepSlug: "a", jobId: "j", error: "boom" },
      "w",
    );
    expect(wf.runs[0]!.status).toBe("failed");
    expect(wf.runs[0]!.steps[0]!.status).toBe("failed");
  });

  test("sets the final run status and completion time", () => {
    const completed = applyWorkflowEvent(base(), { type: "workflow_completed", workflowRunId: "r1" }, "w").runs[0]!;
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBeNumber();
    const failed = applyWorkflowEvent(
      base(),
      { type: "workflow_failed", workflowRunId: "r1", failedStep: "a", error: "boom" },
      "w",
    ).runs[0]!;
    expect(failed.status).toBe("failed");
    expect(failed.completedAt).toBeNumber();
  });

  test("marks dead steps so not-taken branches don't keep the run waiting", () => {
    let wf = applyWorkflowEvent(
      base(),
      { type: "workflow_step_completed", workflowRunId: "r1", stepSlug: "a", jobId: "j" },
      "w",
    );
    wf = applyWorkflowEvent(wf, { type: "workflow_step_dead", workflowRunId: "r1", stepSlug: "b" }, "w");
    expect(wf.runs[0]!.steps[1]!.status).toBe("dead");
    expect(aggregateStepStatus(wf.runs[0]!.steps)).toBe("completed");
  });

  test("removes deleted runs", () => {
    expect(applyWorkflowEvent(base(), { type: "workflow_run_removed", workflowRunId: "r1" }, "w").runs).toEqual([]);
  });

  test("returns the same object for unrelated events", () => {
    const wf = base();
    expect(applyWorkflowEvent(wf, { type: "workflow_reload" }, "w")).toBe(wf);
  });
});
