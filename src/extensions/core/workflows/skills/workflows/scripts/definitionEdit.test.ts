import { describe, expect, test } from "bun:test";
import { addEdge, type RawDefinition, removeEdge, removeStep, setMeta, setStep } from "./definitionEdit";

/** a -> route (case) -> yes | no */
function def(): RawDefinition {
  return {
    name: "wf",
    draft: true,
    trigger: { type: "manual" },
    steps: {
      a: { type: "agent", prompt: "A" },
      route: { type: "case", match: "{{steps.a.result}}", paths: ["yes", "no"] },
      yes: { type: "noop" },
      no: { type: "noop" },
    },
    edges: [
      { from: "a", to: "route" },
      { from: "route", to: "yes", branch: "yes" },
      { from: "route", to: "no", branch: "no" },
    ],
  };
}

function ok(result: ReturnType<typeof setStep>): RawDefinition {
  if (!result.ok) throw new Error(result.error);
  return result.definition;
}

function error(result: ReturnType<typeof setStep>): string {
  if (result.ok) throw new Error("expected an error");
  return result.error;
}

describe("setStep", () => {
  test("creates a step and leaves the input untouched", () => {
    const input = def();
    const out = ok(setStep(input, "b", { type: "noop" }));
    expect((out.steps as Record<string, unknown>).b).toEqual({ type: "noop" });
    expect((input.steps as Record<string, unknown>).b).toBeUndefined();
    expect(out.draft).toBe(true);
    expect(out.edges).toEqual(input.edges);
  });

  test("replaces a step as a whole", () => {
    const out = ok(setStep(def(), "a", { type: "agent", prompt: "new" }));
    expect((out.steps as Record<string, unknown>).a).toEqual({ type: "agent", prompt: "new" });
  });

  test("refuses a step that is not an object", () => {
    expect(error(setStep(def(), "a", "text"))).toContain("must be a JSON5 object");
    expect(error(setStep(def(), "a", [1]))).toContain("must be a JSON5 object");
  });
});

describe("removeStep", () => {
  test("removes the step and every edge from or to it", () => {
    const out = ok(removeStep(def(), "route"));
    expect(Object.keys(out.steps as object)).toEqual(["a", "yes", "no"]);
    expect(out.edges).toEqual([]);
  });

  test("refuses an unknown slug and names the steps", () => {
    expect(error(removeStep(def(), "nope"))).toBe('Unknown step "nope" (steps: a, route, yes, no)');
  });
});

describe("addEdge", () => {
  test("adds an edge, with a branch when given", () => {
    expect(ok(addEdge(def(), "a", "yes")).edges).toContainEqual({ from: "a", to: "yes" });
    expect(ok(addEdge(def(), "route", "a", "no")).edges).toContainEqual({ from: "route", to: "a", branch: "no" });
  });

  test("refuses unknown slugs", () => {
    expect(error(addEdge(def(), "x", "a"))).toContain('Unknown step "x"');
    expect(error(addEdge(def(), "a", "x"))).toContain('Unknown step "x"');
  });

  test("refuses a duplicate edge, same branch included", () => {
    expect(error(addEdge(def(), "a", "route"))).toBe('Edge "a" -> "route" already exists');
    expect(error(addEdge(def(), "route", "yes", "yes"))).toContain("already exists");
    // Same steps, other branch: a new edge.
    expect(ok(addEdge(def(), "route", "yes", "no")).edges).toHaveLength(4);
  });
});

describe("removeEdge", () => {
  test("removes the edge between two steps", () => {
    expect(ok(removeEdge(def(), "a", "route")).edges).toHaveLength(2);
  });

  test("with a branch, removes only that edge", () => {
    const input = def();
    (input.edges as unknown[]).push({ from: "route", to: "yes", branch: "no" });
    const out = ok(removeEdge(input, "route", "yes", "no"));
    expect(out.edges).toContainEqual({ from: "route", to: "yes", branch: "yes" });
    expect(out.edges).not.toContainEqual({ from: "route", to: "yes", branch: "no" });
  });

  test("refuses when no edge matches and lists the edges of the source", () => {
    expect(error(removeEdge(def(), "route", "yes", "maybe"))).toBe(
      'No edge "route" -> "yes" (branch "maybe") (edges from "route": "route" -> "yes" (branch "yes"), "route" -> "no" (branch "no"))',
    );
    expect(error(removeEdge(def(), "yes", "no"))).toBe('No edge "yes" -> "no"');
  });
});

describe("setMeta", () => {
  test("shallow-merges description, group, and trigger", () => {
    const out = ok(setMeta(def(), { description: "d", group: "g", trigger: { type: "webhook", ref: "x" } }));
    expect(out).toMatchObject({ description: "d", group: "g", trigger: { type: "webhook", ref: "x" }, draft: true });
  });

  test("null removes description or group", () => {
    const out = ok(setMeta({ ...def(), description: "d", group: "g" }, { description: null, group: null }));
    expect(out).not.toHaveProperty("description");
    expect(out).not.toHaveProperty("group");
  });

  test("refuses every other field", () => {
    for (const key of ["name", "draft", "enabled", "steps", "edges"]) {
      expect(error(setMeta(def(), { [key]: 1 }))).toContain(`Cannot set "${key}"`);
    }
  });

  test("refuses a non-object and an empty object", () => {
    expect(error(setMeta(def(), "x"))).toContain("must be a JSON5 object");
    expect(error(setMeta(def(), {}))).toContain("Nothing to set");
  });
});
