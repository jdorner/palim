import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@ext/types";
import { getOutcomeCoverageWarnings } from "./outcomeCoverage";
import type { DagWorkflowDefinition, Edge } from "./schemas";
import { createWorkflowAnalyzer } from "./workflowAnalysis";

const OUTCOMES = [
  { id: "approve", label: "Approve" },
  { id: "reject", label: "Reject" },
  { id: "rework", label: "Try again" },
];

/** A review task, a `case` on its outcome, and the given edges from the case. */
function wf(
  review: Record<string, unknown>,
  route: Record<string, unknown>,
  routeEdges: Edge[] = [],
): DagWorkflowDefinition {
  return {
    name: "coverage",
    trigger: { type: "manual" },
    steps: {
      review: { type: "humanTask", title: "Review", assignees: { roles: ["portal-user"] }, ...review } as never,
      route: { type: "case", match: "{{steps.review.result.outcome}}", ...route } as never,
      done: { type: "agent", prompt: "done" },
    },
    edges: [{ from: "review", to: "route" }, ...routeEdges],
  };
}

const messages = (def: DagWorkflowDefinition) => getOutcomeCoverageWarnings(def).map((w) => w.message);

describe("getOutcomeCoverageWarnings", () => {
  test("warns about an outcome without a path, on the case's paths field", () => {
    const warnings = getOutcomeCoverageWarnings(wf({ outcomes: OUTCOMES }, { paths: ["approve", "reject"] }));
    expect(warnings).toEqual([
      {
        stepSlug: "route",
        field: "paths",
        message: 'Outcome "rework" of "review" has no path in "route": choosing it fails the run',
      },
    ]);
  });

  test("no warning when every outcome has a path", () => {
    expect(messages(wf({ outcomes: OUTCOMES }, { paths: ["approve", "reject", "rework"] }))).toEqual([]);
  });

  test("a default covers missing outcomes", () => {
    expect(messages(wf({ outcomes: OUTCOMES }, { paths: ["approve", "reject"], default: "reject" }))).toEqual([]);
  });

  test("an edge with branch default covers missing outcomes", () => {
    const def = wf({ outcomes: OUTCOMES }, { paths: ["approve"] }, [{ from: "route", to: "done", branch: "default" }]);
    expect(messages(def)).toEqual([]);
  });

  test("a default edge of another step does not count", () => {
    const def = wf({ outcomes: OUTCOMES }, { paths: ["approve", "reject"] });
    def.steps.other = { type: "case", match: "x", paths: ["a"] } as never;
    def.edges.push({ from: "other", to: "done", branch: "default" });
    expect(messages(def)).toEqual(['Outcome "rework" of "review" has no path in "route": choosing it fails the run']);
  });

  test("expects expired with onTimeout expire", () => {
    const def = wf(
      { outcomes: OUTCOMES, timeout: 60_000, onTimeout: "expire" },
      { paths: ["approve", "reject", "rework"] },
    );
    expect(messages(def)).toEqual(['Outcome "expired" of "review" has no path in "route": the timeout fails the run']);
  });

  test("an expired path without onTimeout expire never matches, even with a default", () => {
    const def = wf({ outcomes: OUTCOMES }, { paths: ["approve", "reject", "rework", "expired"], default: "reject" });
    expect(messages(def)).toEqual([
      'Path "expired" of "route" never matches: "review" has no such outcome (it needs a timeout and onTimeout: "expire")',
    ]);
  });

  test("onTimeout expire without a timeout never expires", () => {
    expect(
      messages(wf({ outcomes: OUTCOMES, onTimeout: "expire" }, { paths: ["approve", "reject", "rework"] })),
    ).toEqual([]);
    expect(
      messages(wf({ outcomes: OUTCOMES, onTimeout: "expire" }, { paths: ["approve", "reject", "rework", "expired"] })),
    ).toEqual([
      'Path "expired" of "route" never matches: "review" has no such outcome (it needs a timeout and onTimeout: "expire")',
    ]);
  });

  test("an expired path is fine with onTimeout expire", () => {
    const def = wf(
      { outcomes: OUTCOMES, timeout: 60_000, onTimeout: "expire" },
      { paths: ["approve", "reject", "rework", "expired"] },
    );
    expect(messages(def)).toEqual([]);
  });

  test("uses approve and reject when no outcomes are declared", () => {
    expect(messages(wf({}, { paths: ["approve", "reject"] }))).toEqual([]);
    expect(messages(wf({}, { paths: ["approve"] }))).toEqual([
      'Outcome "reject" of "review" has no path in "route": choosing it fails the run',
    ]);
  });

  test("warns about a stale path", () => {
    expect(messages(wf({}, { paths: ["approve", "reject", "maybe"] }))).toEqual([
      'Path "maybe" of "route" never matches: "review" has no such outcome',
    ]);
  });

  test("the default key may be a path of its own", () => {
    expect(messages(wf({}, { paths: ["approve", "reject", "other"], default: "other" }))).toEqual([]);
  });

  test("a declared path without an edge is silent", () => {
    // No edges from the case at all: each path just ends the run.
    expect(messages(wf({ outcomes: OUTCOMES }, { paths: ["approve", "reject", "rework"] }))).toEqual([]);
  });

  test("allows whitespace inside the braces", () => {
    const def = wf({}, { match: "{{ steps.review.result.outcome }}", paths: ["approve"] });
    expect(messages(def)).toEqual(['Outcome "reject" of "review" has no path in "route": choosing it fails the run']);
  });

  test("ignores a match on another result field", () => {
    expect(messages(wf({}, { match: "{{steps.review.result.comment}}", paths: ["x"] }))).toEqual([]);
  });

  test("ignores a match on a step that is not a human task", () => {
    expect(messages(wf({}, { match: "{{steps.done.result.outcome}}", paths: ["x"] }))).toEqual([]);
  });

  test("ignores a match on an unknown step", () => {
    expect(messages(wf({}, { match: "{{steps.missing.result.outcome}}", paths: ["x"] }))).toEqual([]);
  });

  test("says the coverage is not checked for another form of the outcome", () => {
    const unchecked =
      'Outcome coverage of "review" is not checked: use exactly {{steps.review.result.outcome}} as the match';
    for (const match of [
      "outcome: {{steps.review.result.outcome}}",
      "{{steps.review.result.outcome}}-x",
      "{{ lower(steps.review.result.outcome) }}",
    ]) {
      const warnings = getOutcomeCoverageWarnings(wf({}, { match, paths: ["x"] }));
      expect(warnings).toEqual([{ stepSlug: "route", field: "match", message: unchecked }]);
    }
  });

  test("no unchecked hint for another step's outcome field", () => {
    expect(messages(wf({}, { match: "{{ lower(steps.done.result.outcome) }}", paths: ["x"] }))).toEqual([]);
  });

  test("a workflow without a human task has no warnings", () => {
    const def: DagWorkflowDefinition = {
      name: "plain",
      trigger: { type: "manual" },
      steps: { route: { type: "case", match: "{{trigger.payload.kind}}", paths: ["a", "b"] } as never },
      edges: [],
    };
    expect(messages(def)).toEqual([]);
  });
});

describe("createWorkflowAnalyzer", () => {
  test("includes the outcome coverage warnings", async () => {
    const ctx = {
      tools: { names: () => [] },
      skills: { names: () => [] },
      stepTypes: { get: () => undefined },
      internal: { hitl: {} },
    } as unknown as ExtensionContext;
    const analyze = createWorkflowAnalyzer(ctx);
    const { warnings } = await analyze(wf({ outcomes: OUTCOMES }, { paths: ["approve", "reject"] }), {
      webhook: null,
      schedule: null,
      filewatcher: null,
    });
    expect(warnings).toContainEqual({
      stepSlug: "route",
      field: "paths",
      message: 'Outcome "rework" of "review" has no path in "route": choosing it fails the run',
    });
  });
});
