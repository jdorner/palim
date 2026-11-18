import { describe, expect, test } from "bun:test";
import { renderOutline } from "./outline";
import type { DagWorkflowDefinition } from "./schemas";

function wf(overrides: Partial<DagWorkflowDefinition>): DagWorkflowDefinition {
  return { name: "wf", trigger: { type: "manual" }, steps: {}, edges: [], ...overrides } as DagWorkflowDefinition;
}

describe("renderOutline", () => {
  test("linear workflow: header, steps in execution order, end marker", () => {
    const out = renderOutline(
      wf({
        steps: { b: { type: "agent", prompt: "B" }, a: { type: "agent", prompt: "A" } },
        edges: [{ from: "a", to: "b" }],
      }),
    );
    expect(out).toBe(["wf · trigger: manual · inputs: none", "", "a  agent  -> b", "b  agent  (end)"].join("\n"));
  });

  test("header shows draft, disabled, trigger ref, and inputs", () => {
    const out = renderOutline(
      wf({
        draft: true,
        enabled: false,
        trigger: { type: "webhook", ref: "hook", outputSchema: { city: "string", days: "number" } },
        steps: { a: { type: "agent", prompt: "A" } },
      } as Partial<DagWorkflowDefinition>),
    );
    expect(out.split("\n")[0]).toBe("wf (draft, disabled) · trigger: webhook hook · inputs: city, days");
  });

  test("fan-out lists every target", () => {
    const out = renderOutline(
      wf({
        steps: { a: { type: "agent", prompt: "A" }, b: { type: "noop" }, c: { type: "noop" } },
        edges: [
          { from: "a", to: "b" },
          { from: "a", to: "c" },
        ],
      }),
    );
    expect(out).toContain("a  agent  -> b, c");
  });

  test("case lists each path with its target, a path without an edge ends the run", () => {
    const out = renderOutline(
      wf({
        steps: {
          route: { type: "case", match: "{{trigger.payload.x}}", paths: ["yes", "no", "later"], default: "other" },
          y: { type: "noop" },
          o: { type: "noop" },
        },
        edges: [
          { from: "route", to: "y", branch: "yes" },
          { from: "route", to: "y", branch: "no" },
          { from: "route", to: "o", branch: "other" },
        ],
      } as Partial<DagWorkflowDefinition>),
    );
    expect(out).toContain("route  case  yes -> y | no -> y | later -> (end) | other -> o");
  });

  test("if shows then and else", () => {
    const out = renderOutline(
      wf({
        steps: { check: { type: "if", condition: "true" }, t: { type: "noop" } },
        edges: [{ from: "check", to: "t", branch: "then" }],
      } as Partial<DagWorkflowDefinition>),
    );
    expect(out).toContain("check  if    then -> t | else -> (end)");
  });

  test("human task line: assignees, outcomes, form, timeout", () => {
    const out = renderOutline(
      wf({
        steps: {
          review: {
            type: "humanTask",
            title: "Review",
            assignees: { roles: ["portal-user"], users: ["joe"] },
            outcomes: [
              { id: "approve", label: "A" },
              { id: "rework", label: "R" },
            ],
            form: { type: "object", properties: { costCenter: { type: "string" } } },
            timeout: 1000,
            onTimeout: "expire",
          },
          route: { type: "case", match: "{{steps.review.result.outcome}}", paths: ["approve"] },
        },
        edges: [{ from: "review", to: "route" }],
      } as Partial<DagWorkflowDefinition>),
    );
    expect(out).toContain(
      "review  humanTask  -> route  roles: portal-user · users: joe · outcomes: approve, rework · form: costCenter · on timeout: expired",
    );
    // A long branch list does not push the details column.
    expect(out).toContain("route   case       approve -> (end)");
  });

  test("human task with default outcomes and a failing timeout", () => {
    const out = renderOutline(
      wf({
        steps: { review: { type: "humanTask", title: "R", assignees: { users: ["joe"] }, timeout: 1000 } },
      } as Partial<DagWorkflowDefinition>),
    );
    expect(out).toContain("users: joe · outcomes: approve, reject · on timeout: fail");
  });

  test("lists warnings below the steps", () => {
    const out = renderOutline(wf({ steps: { a: { type: "agent", prompt: "A" } } }), [
      { stepSlug: "a", field: "prompt", message: "bad ref" },
      { stepSlug: "", field: "pairing", message: "no aggregator" },
    ]);
    expect(out.endsWith("\n\nWarnings:\n  a.prompt: bad ref\n  pairing: no aggregator")).toBe(true);
  });
});
