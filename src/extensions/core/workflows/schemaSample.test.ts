import { describe, expect, test } from "bun:test";
import type { DagWorkflowRun } from "./dagRunStore";
import { inferSchemaFromRuns } from "./schemaSample";

function run(id: string, createdAt: number, triggerPayload: unknown, stepResults: Record<string, unknown> = {}) {
  return {
    id,
    workflowName: "wf",
    status: "completed",
    edgeStates: {},
    stepStatuses: {},
    stepResults,
    triggerPayload,
    failureReason: null,
    createdByUserId: null,
    createdAt,
    updatedAt: createdAt,
  } as DagWorkflowRun;
}

describe("inferSchemaFromRuns", () => {
  test("uses the newest run with an object payload", () => {
    const runs = [run("old", 1, { a: 1 }), run("new", 3, "plain text"), run("mid", 2, { b: "x" })];
    expect(inferSchemaFromRuns(runs, { kind: "trigger" })).toEqual({
      runId: "mid",
      runCreatedAt: 2,
      shorthand: { b: "string" },
    });
  });

  test("reads a step result by slug, skipping runs without it", () => {
    const runs = [
      run("a", 2, null, { other: { x: 1 } }),
      run("b", 1, null, { fetch: { status: 200, body: { ok: true } } }),
    ];
    expect(inferSchemaFromRuns(runs, { kind: "step", slug: "fetch" })?.shorthand).toEqual({
      status: "number",
      body: { ok: "boolean" },
    });
  });

  test("returns null when no run has a usable sample", () => {
    expect(inferSchemaFromRuns([run("a", 1, "x", { s: "text" })], { kind: "step", slug: "s" })).toBeNull();
    expect(inferSchemaFromRuns([], { kind: "trigger" })).toBeNull();
  });
});
