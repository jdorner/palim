import { describe, expect, test } from "bun:test";
import { addEdge, addLoop, type RawDefinition, removeEdge, removeStep, setMeta, setStep } from "./definitionEdit";

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

/** fetch -> classify -> tag -> notify */
function linear(): RawDefinition {
  return {
    name: "tagging",
    draft: true,
    trigger: { type: "manual" },
    steps: {
      fetch: { type: "imap-fetch" },
      classify: { type: "agent", prompt: "Classify {{steps.fetch.result.messages}}" },
      tag: { type: "noop" },
      notify: { type: "noop" },
    },
    edges: [
      { from: "fetch", to: "classify" },
      { from: "classify", to: "tag" },
      { from: "tag", to: "notify" },
    ],
  };
}

const LOOP = { slug: "each-mail", over: "{{steps.fetch.result.messages}}", as: "mail" };

describe("addLoop", () => {
  test("wraps a one-step body and leaves the input untouched", () => {
    const input = linear();
    const result = addLoop(input, { ...LOOP, from: "classify", to: "classify" });
    if (!result.ok) throw new Error(result.error);
    expect(result.aggregator).toBe("each-mail-done");
    expect(result.body).toEqual(["classify"]);
    const steps = result.definition.steps as Record<string, unknown>;
    expect(steps["each-mail"]).toEqual({ type: "iterator", items: "{{steps.fetch.result.messages}}", as: "mail" });
    expect(steps["each-mail-done"]).toEqual({ type: "aggregator", iterator: "each-mail" });
    expect(steps.classify).toEqual((input.steps as Record<string, unknown>).classify);
    expect(result.definition.edges).toEqual([
      { from: "fetch", to: "each-mail" },
      { from: "each-mail-done", to: "tag" },
      { from: "tag", to: "notify" },
      { from: "each-mail", to: "classify", branch: "each" },
      { from: "classify", to: "each-mail-done" },
    ]);
    expect(input.edges).toEqual(linear().edges);
    expect(result.definition.draft).toBe(true);
  });

  test("wraps a multi-step body, including steps on parallel paths between first and last", () => {
    const def = linear();
    (def.steps as Record<string, unknown>).side = { type: "noop" };
    (def.edges as unknown[]).push({ from: "classify", to: "side" }, { from: "side", to: "tag" });
    const result = addLoop(def, { ...LOOP, from: "classify", to: "tag" });
    if (!result.ok) throw new Error(result.error);
    expect(result.body.sort()).toEqual(["classify", "side", "tag"]);
    expect(result.definition.edges).toContainEqual({ from: "classify", to: "tag" });
    expect(result.definition.edges).toContainEqual({ from: "each-mail-done", to: "notify" });
    expect(result.definition.edges).toContainEqual({ from: "tag", to: "each-mail-done" });
  });

  test("makes the iterator the root when the body starts the graph, and accepts --over without braces", () => {
    const result = addLoop(linear(), { slug: "each", over: "trigger.payload.rows", from: "fetch", to: "fetch" });
    if (!result.ok) throw new Error(result.error);
    expect(result.over).toBe("{{trigger.payload.rows}}");
    expect((result.definition.steps as Record<string, Record<string, unknown>>).each).toEqual({
      type: "iterator",
      items: "{{trigger.payload.rows}}",
    });
    const edges = result.definition.edges as { from: string; to: string }[];
    expect(edges.some((e) => e.to === "each")).toBe(false);
    expect(edges).toContainEqual({ from: "each-done", to: "classify" });
  });

  test("ends the graph with the aggregator when the body is at the end", () => {
    const result = addLoop(linear(), { ...LOOP, from: "notify", to: "notify" });
    if (!result.ok) throw new Error(result.error);
    const edges = result.definition.edges as { from: string; to: string }[];
    expect(edges.some((e) => e.from === "each-mail-done")).toBe(false);
    expect(edges).toContainEqual({ from: "tag", to: "each-mail" });
  });

  test("keeps the branch of an edge that entered the body", () => {
    const result = addLoop(def(), { slug: "each", over: "{{steps.a.result}}", from: "yes", to: "yes" });
    if (!result.ok) throw new Error(result.error);
    expect(result.definition.edges).toContainEqual({ from: "route", to: "each", branch: "yes" });
  });

  describe("refusals", () => {
    const refuse = (definition: RawDefinition, options: Partial<Parameters<typeof addLoop>[1]>) => {
      const result = addLoop(definition, { ...LOOP, from: "classify", to: "tag", ...options });
      if (result.ok) throw new Error("expected a refusal");
      return result.error;
    };

    test("taken slugs", () => {
      expect(refuse(linear(), { slug: "classify" })).toContain('A step "classify" already exists');
      const def = linear();
      (def.steps as Record<string, unknown>)["each-mail-done"] = { type: "noop" };
      expect(refuse(def, {})).toContain('A step "each-mail-done" already exists');
    });

    test("unknown steps and an empty list", () => {
      expect(refuse(linear(), { from: "nope" })).toContain('Unknown step "nope"');
      expect(refuse(linear(), { to: "nope" })).toContain('Unknown step "nope"');
      expect(refuse(linear(), { over: "{{ }}" })).toContain("--over needs");
    });

    test("a last step not reachable from the first", () => {
      expect(refuse(linear(), { from: "tag", to: "classify" })).toContain('"classify" cannot be reached from "tag"');
    });

    test("a body step with an edge from or to outside the body", () => {
      const into = linear();
      (into.edges as unknown[]).push({ from: "fetch", to: "tag" });
      expect(refuse(into, {})).toContain('Body step "tag" also has an edge from "fetch"');
      const out = linear();
      (out.edges as unknown[]).push({ from: "classify", to: "notify" });
      expect(refuse(out, {})).toContain('Body step "classify" also has an edge to "notify"');
    });

    test("a body inside or around another loop, and a branching last step", () => {
      const looped = addLoop(linear(), { ...LOOP, from: "classify", to: "tag" });
      if (!looped.ok) throw new Error(looped.error);
      expect(refuse(looped.definition, { slug: "inner", from: "classify", to: "classify" })).toContain(
        'already inside the loop "each-mail"',
      );
      expect(refuse(looped.definition, { slug: "outer", from: "each-mail", to: "each-mail-done" })).toContain(
        "loops inside loops are not supported",
      );
      expect(refuse(def(), { slug: "x", over: "{{steps.a.result}}", from: "a", to: "route" })).toContain(
        'The last body step "route" is a case',
      );
    });
  });
});
