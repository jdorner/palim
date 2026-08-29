import { describe, expect, test } from "bun:test";
import {
  BUILTIN_STEP_TYPES,
  type BuilderConfig,
  type BuilderDraft,
  type EdgeDraft,
  getDescriptor,
  type StepDraft,
  type StepTypeDescriptor,
  WorkflowBuilder,
} from "./workflowBuilder";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let idCounter = 0;
let slugCounter = 0;

function resetCounters() {
  idCounter = 0;
  slugCounter = 0;
}

function testConfig(extra: StepTypeDescriptor[] = []): BuilderConfig {
  resetCounters();
  return {
    stepTypes: [...BUILTIN_STEP_TYPES, ...extra],
    idFactory: () => `id-${++idCounter}`,
    slugFactory: () => `step-${++slugCounter}`,
  };
}

function makeStep(id: string, type: string, extra: Record<string, unknown> = {}): StepDraft {
  return { id, slug: id, type, ...extra };
}

function makeDraft(steps: StepDraft[], edges: EdgeDraft[]): BuilderDraft {
  return { steps, edges };
}

/** Extracts the `id` of a step, asserting it's defined. */
function stepId(step: StepDraft): string {
  if (!step.id) throw new Error("Step has no id");
  return step.id;
}

// ---------------------------------------------------------------------------
// Descriptor lookup
// ---------------------------------------------------------------------------

describe("getDescriptor", () => {
  test("returns correct descriptor for known types", () => {
    const ifDesc = getDescriptor("if", BUILTIN_STEP_TYPES);
    expect(ifDesc.type).toBe("if");
    expect(ifDesc.branches).toEqual(["then", "else"]);
    expect(ifDesc.defaultBranch).toBe("then");
    expect(ifDesc.terminal).toBeUndefined();
  });

  test("returns iterator descriptor with paired info", () => {
    const iterDesc = getDescriptor("iterator", BUILTIN_STEP_TYPES);
    expect(iterDesc.type).toBe("iterator");
    expect(iterDesc.branches).toEqual(["each"]);
    expect(iterDesc.defaultBranch).toBe("each");
    expect(iterDesc.paired).toEqual({ type: "aggregator", ref: "iterator", branch: "each" });
  });

  test("returns terminal descriptor for fail", () => {
    const failDesc = getDescriptor("fail", BUILTIN_STEP_TYPES);
    expect(failDesc.terminal).toBe(true);
    expect(failDesc.branches).toEqual([]);
  });

  test("returns pass-through default for unknown types", () => {
    const desc = getDescriptor("custom-notify", BUILTIN_STEP_TYPES);
    expect(desc.type).toBe("custom-notify");
    expect(desc.branches).toEqual([]);
    expect(desc.defaultBranch).toBeUndefined();
    expect(desc.paired).toBeUndefined();
    expect(desc.terminal).toBeUndefined();
  });

  test("agent is a pass-through type", () => {
    const desc = getDescriptor("agent", BUILTIN_STEP_TYPES);
    expect(desc.branches).toEqual([]);
    expect(desc.defaultBranch).toBeUndefined();
    expect(desc.paired).toBeUndefined();
  });

  test("case has defaultBranch 'default' with empty branches", () => {
    const desc = getDescriptor("case", BUILTIN_STEP_TYPES);
    expect(desc.branches).toEqual([]);
    expect(desc.defaultBranch).toBe("default");
  });
});

// ---------------------------------------------------------------------------
// insertBetween
// ---------------------------------------------------------------------------

describe("WorkflowBuilder.insertBetween", () => {
  test("insert pass-through between plain nodes", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft([makeStep("A", "agent"), makeStep("B", "agent")], [{ from: "A", to: "B" }]);

    const result = builder.insertBetween(draft, "A", "B", "agent");

    expect(result.steps).toHaveLength(3);
    const newStep = result.steps.find((s) => s.id !== "A" && s.id !== "B")!;
    expect(newStep.type).toBe("agent");
    expect(result.edges).toContainEqual({ from: "A", to: stepId(newStep) });
    expect(result.edges).toContainEqual({ from: stepId(newStep), to: "B" });
    expect(result.edges.find((e) => e.from === "A" && e.to === "B")).toBeUndefined();
  });

  test("insert pass-through on a branch edge", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft(
      [makeStep("iter", "iterator"), makeStep("agg", "aggregator")],
      [{ from: "iter", to: "agg", branch: "each" }],
    );

    const result = builder.insertBetween(draft, "iter", "agg", "agent", "each");

    const newStep = result.steps.find((s) => s.id !== "iter" && s.id !== "agg")!;
    expect(result.edges).toContainEqual({ from: "iter", to: stepId(newStep), branch: "each" });
    expect(result.edges).toContainEqual({ from: stepId(newStep), to: "agg" });
  });

  test("insert CF node (if) between plain nodes", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft([makeStep("A", "agent"), makeStep("B", "agent")], [{ from: "A", to: "B" }]);

    const result = builder.insertBetween(draft, "A", "B", "if");

    const ifNode = result.steps.find((s) => s.type === "if")!;
    expect(result.edges).toContainEqual({ from: "A", to: stepId(ifNode) });
    expect(result.edges).toContainEqual({ from: stepId(ifNode), to: "B", branch: "then" });
    // else branch is absent (dangling)
    expect(result.edges.find((e) => e.from === stepId(ifNode) && e.branch === "else")).toBeUndefined();
  });

  test("insert CF node on a branch edge", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft(
      [makeStep("iter", "iterator"), makeStep("agg", "aggregator")],
      [{ from: "iter", to: "agg", branch: "each" }],
    );

    const result = builder.insertBetween(draft, "iter", "agg", "if", "each");

    const ifNode = result.steps.find((s) => s.type === "if")!;
    expect(result.edges).toContainEqual({ from: "iter", to: stepId(ifNode), branch: "each" });
    expect(result.edges).toContainEqual({ from: stepId(ifNode), to: "agg", branch: "then" });
  });

  test("insert paired type (iterator) between nodes", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft([makeStep("A", "agent"), makeStep("B", "agent")], [{ from: "A", to: "B" }]);

    const result = builder.insertBetween(draft, "A", "B", "iterator");

    expect(result.steps).toHaveLength(4); // A, B, iterator, aggregator
    const iterNode = result.steps.find((s) => s.type === "iterator")!;
    const aggNode = result.steps.find((s) => s.type === "aggregator")!;
    expect(aggNode.iterator).toBe(iterNode.slug);
    expect(result.edges).toContainEqual({ from: "A", to: stepId(iterNode) });
    expect(result.edges).toContainEqual({ from: stepId(iterNode), to: stepId(aggNode), branch: "each" });
    expect(result.edges).toContainEqual({ from: stepId(aggNode), to: "B" });
  });

  test("insert on non-existent edge returns draft unchanged", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft([makeStep("A", "agent"), makeStep("B", "agent")], []);

    const result = builder.insertBetween(draft, "A", "B", "agent");

    expect(result).toBe(draft); // same reference = no-op
  });

  test("insert terminal type between nodes", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft([makeStep("A", "agent"), makeStep("B", "agent")], [{ from: "A", to: "B" }]);

    const result = builder.insertBetween(draft, "A", "B", "fail");

    const failNode = result.steps.find((s) => s.type === "fail")!;
    expect(result.edges).toContainEqual({ from: "A", to: stepId(failNode) });
    // No edge from failNode to B (terminal)
    expect(result.edges.find((e) => e.from === stepId(failNode))).toBeUndefined();
  });

  test("insert case node creates step with default path", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft([makeStep("A", "agent"), makeStep("B", "agent")], [{ from: "A", to: "B" }]);

    const result = builder.insertBetween(draft, "A", "B", "case");

    const caseNode = result.steps.find((s) => s.type === "case")!;
    expect(caseNode.paths).toEqual([]);
    expect(caseNode.default).toBe("default");
    expect(result.edges).toContainEqual({ from: stepId(caseNode), to: "B", branch: "default" });
  });
});

// ---------------------------------------------------------------------------
// insertAtStart
// ---------------------------------------------------------------------------

describe("WorkflowBuilder.insertAtStart", () => {
  test("prepend pass-through before the first root", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft([makeStep("A", "agent"), makeStep("B", "agent")], [{ from: "A", to: "B" }]);

    const result = builder.insertAtStart(draft, "agent");

    expect(result.steps).toHaveLength(3);
    const newStep = result.steps.find((s) => s.id !== "A" && s.id !== "B")!;
    // New step becomes the root: edge from it to the original root (A)
    expect(result.edges).toContainEqual({ from: stepId(newStep), to: "A" });
    // Original edge A->B preserved
    expect(result.edges).toContainEqual({ from: "A", to: "B" });
  });

  test("prepend CF node (if) before the first root uses defaultBranch", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft([makeStep("A", "agent"), makeStep("B", "agent")], [{ from: "A", to: "B" }]);

    const result = builder.insertAtStart(draft, "if");

    const ifNode = result.steps.find((s) => s.type === "if")!;
    expect(result.edges).toContainEqual({ from: stepId(ifNode), to: "A", branch: "then" });
  });

  test("prepend paired type (iterator) before the first root", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft([makeStep("A", "agent")], []);

    const result = builder.insertAtStart(draft, "iterator");

    const iter = result.steps.find((s) => s.type === "iterator")!;
    const agg = result.steps.find((s) => s.type === "aggregator")!;
    expect(result.edges).toContainEqual({ from: stepId(iter), to: stepId(agg), branch: "each" });
    expect(result.edges).toContainEqual({ from: stepId(agg), to: "A" });
  });

  test("prepend to empty draft is a no-op", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft([], []);

    const result = builder.insertAtStart(draft, "agent");

    expect(result).toBe(draft);
  });
});

// ---------------------------------------------------------------------------
// appendAfter
// ---------------------------------------------------------------------------

describe("WorkflowBuilder.appendAfter", () => {
  test("append to a node with no successors", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft([makeStep("A", "agent")], []);

    const result = builder.appendAfter(draft, "A", "agent");

    expect(result.steps).toHaveLength(2);
    const newStep = result.steps.find((s) => s.id !== "A")!;
    expect(result.edges).toContainEqual({ from: "A", to: stepId(newStep) });
  });

  test("append to a specific branch of a CF node", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft(
      [makeStep("ifNode", "if"), makeStep("B", "agent")],
      [{ from: "ifNode", to: "B", branch: "then" }],
    );

    const result = builder.appendAfter(draft, "ifNode", "agent", "else");

    const newStep = result.steps.find((s) => s.id !== "ifNode" && s.id !== "B")!;
    expect(result.edges).toContainEqual({ from: "ifNode", to: stepId(newStep), branch: "else" });
  });

  test("append paired type creates both steps", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft([makeStep("A", "agent")], []);

    const result = builder.appendAfter(draft, "A", "iterator");

    expect(result.steps).toHaveLength(3); // A, iterator, aggregator
    const iterNode = result.steps.find((s) => s.type === "iterator")!;
    const aggNode = result.steps.find((s) => s.type === "aggregator")!;
    expect(result.edges).toContainEqual({ from: "A", to: stepId(iterNode) });
    expect(result.edges).toContainEqual({ from: stepId(iterNode), to: stepId(aggNode), branch: "each" });
  });

  test("append after terminal node is a no-op", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft([makeStep("failNode", "fail")], []);

    const result = builder.appendAfter(draft, "failNode", "agent");

    expect(result).toBe(draft);
  });
});

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

describe("WorkflowBuilder.remove", () => {
  test("remove pass-through node (single input, single output)", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft(
      [makeStep("A", "agent"), makeStep("X", "agent"), makeStep("B", "agent")],
      [
        { from: "A", to: "X" },
        { from: "X", to: "B" },
      ],
    );

    const result = builder.remove(draft, "X");

    expect(result.steps).toHaveLength(2);
    expect(result.steps.find((s) => s.id === "X")).toBeUndefined();
    expect(result.edges).toContainEqual({ from: "A", to: "B" });
  });

  test("remove pass-through node with branch on incoming edge", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft(
      [makeStep("ifNode", "if"), makeStep("X", "agent"), makeStep("B", "agent")],
      [
        { from: "ifNode", to: "X", branch: "then" },
        { from: "X", to: "B" },
      ],
    );

    const result = builder.remove(draft, "X");

    expect(result.edges).toContainEqual({ from: "ifNode", to: "B", branch: "then" });
  });

  test("remove tail node (zero wired outputs)", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft([makeStep("A", "agent"), makeStep("X", "agent")], [{ from: "A", to: "X" }]);

    const result = builder.remove(draft, "X");

    expect(result.steps).toHaveLength(1);
    expect(result.edges).toHaveLength(0);
  });

  test("remove CF node with single wired branch (splice out)", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft(
      [makeStep("A", "agent"), makeStep("ifNode", "if"), makeStep("B", "agent")],
      [
        { from: "A", to: "ifNode" },
        { from: "ifNode", to: "B", branch: "then" },
      ],
    );

    const result = builder.remove(draft, "ifNode");

    expect(result.steps).toHaveLength(2);
    expect(result.edges).toContainEqual({ from: "A", to: "B" });
  });

  test("remove CF node with multiple wired branches (reconnect through defaultBranch)", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft(
      [makeStep("A", "agent"), makeStep("ifNode", "if"), makeStep("B", "agent"), makeStep("C", "agent")],
      [
        { from: "A", to: "ifNode" },
        { from: "ifNode", to: "B", branch: "then" },
        { from: "ifNode", to: "C", branch: "else" },
      ],
    );

    const result = builder.remove(draft, "ifNode");

    expect(result.steps).toHaveLength(3); // A, B, C remain
    expect(result.edges).toContainEqual({ from: "A", to: "B" }); // reconnected through "then"
    // C is now orphaned (no edge to it)
    expect(result.edges.find((e) => e.to === "C")).toBeUndefined();
  });

  test("remove iterator cascades pair and body", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft(
      [
        makeStep("X", "agent"),
        makeStep("iter", "iterator"),
        makeStep("bodyA", "agent"),
        makeStep("bodyB", "agent"),
        makeStep("agg", "aggregator", { iterator: "iter" }),
        makeStep("Y", "agent"),
      ],
      [
        { from: "X", to: "iter" },
        { from: "iter", to: "bodyA", branch: "each" },
        { from: "bodyA", to: "bodyB" },
        { from: "bodyB", to: "agg" },
        { from: "agg", to: "Y" },
      ],
    );

    const result = builder.remove(draft, "iter");

    expect(result.steps).toHaveLength(2); // X, Y remain
    expect(result.steps.map((s) => s.id).sort()).toEqual(["X", "Y"]);
    expect(result.edges).toContainEqual({ from: "X", to: "Y" });
  });

  test("remove aggregator triggers same cascade", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft(
      [
        makeStep("X", "agent"),
        makeStep("iter", "iterator"),
        makeStep("bodyA", "agent"),
        makeStep("agg", "aggregator", { iterator: "iter" }),
        makeStep("Y", "agent"),
      ],
      [
        { from: "X", to: "iter" },
        { from: "iter", to: "bodyA", branch: "each" },
        { from: "bodyA", to: "agg" },
        { from: "agg", to: "Y" },
      ],
    );

    const result = builder.remove(draft, "agg");

    expect(result.steps).toHaveLength(2);
    expect(result.steps.map((s) => s.id).sort()).toEqual(["X", "Y"]);
    expect(result.edges).toContainEqual({ from: "X", to: "Y" });
  });

  test("remove node with multiple predecessors", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft(
      [makeStep("A", "agent"), makeStep("B", "agent"), makeStep("X", "agent"), makeStep("Y", "agent")],
      [
        { from: "A", to: "X" },
        { from: "B", to: "X" },
        { from: "X", to: "Y" },
      ],
    );

    const result = builder.remove(draft, "X");

    expect(result.steps).toHaveLength(3);
    expect(result.edges).toContainEqual({ from: "A", to: "Y" });
    expect(result.edges).toContainEqual({ from: "B", to: "Y" });
  });

  test("remove non-existent node returns draft unchanged", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft([makeStep("A", "agent")], []);

    const result = builder.remove(draft, "Z");

    expect(result).toBe(draft);
  });
});

// ---------------------------------------------------------------------------
// addToBranch
// ---------------------------------------------------------------------------

describe("WorkflowBuilder.addToBranch", () => {
  test("add step to empty branch", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft(
      [makeStep("ifNode", "if"), makeStep("B", "agent")],
      [{ from: "ifNode", to: "B", branch: "then" }],
    );

    const result = builder.addToBranch(draft, "ifNode", "else", "agent");

    const newStep = result.steps.find((s) => s.id !== "ifNode" && s.id !== "B")!;
    expect(newStep.type).toBe("agent");
    expect(result.edges).toContainEqual({ from: "ifNode", to: stepId(newStep), branch: "else" });
  });

  test("add step to already-wired branch is a no-op", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft(
      [makeStep("ifNode", "if"), makeStep("B", "agent")],
      [{ from: "ifNode", to: "B", branch: "then" }],
    );

    const result = builder.addToBranch(draft, "ifNode", "then", "agent");

    expect(result).toBe(draft);
  });

  test("add paired type to empty branch", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft(
      [makeStep("ifNode", "if"), makeStep("B", "agent")],
      [{ from: "ifNode", to: "B", branch: "then" }],
    );

    const result = builder.addToBranch(draft, "ifNode", "else", "iterator");

    const iterNode = result.steps.find((s) => s.type === "iterator")!;
    const aggNode = result.steps.find((s) => s.type === "aggregator")!;
    expect(result.edges).toContainEqual({ from: "ifNode", to: stepId(iterNode), branch: "else" });
    expect(result.edges).toContainEqual({ from: stepId(iterNode), to: stepId(aggNode), branch: "each" });
  });
});

// ---------------------------------------------------------------------------
// connect / disconnect
// ---------------------------------------------------------------------------

describe("WorkflowBuilder.connect", () => {
  test("connect two nodes without branch", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft([makeStep("A", "agent"), makeStep("B", "agent")], []);

    const result = builder.connect(draft, "A", "B");

    expect(result.edges).toContainEqual({ from: "A", to: "B" });
  });

  test("connect with branch", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft([makeStep("ifNode", "if"), makeStep("B", "agent")], []);

    const result = builder.connect(draft, "ifNode", "B", "else");

    expect(result.edges).toContainEqual({ from: "ifNode", to: "B", branch: "else" });
  });

  test("connect duplicate edge is idempotent", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft([makeStep("A", "agent"), makeStep("B", "agent")], [{ from: "A", to: "B" }]);

    const result = builder.connect(draft, "A", "B");

    expect(result).toBe(draft);
  });
});

describe("WorkflowBuilder.disconnect", () => {
  test("disconnect existing edge", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft([makeStep("A", "agent"), makeStep("B", "agent")], [{ from: "A", to: "B" }]);

    const result = builder.disconnect(draft, "A", "B");

    expect(result.edges).toHaveLength(0);
  });

  test("disconnect branch edge", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft(
      [makeStep("ifNode", "if"), makeStep("B", "agent")],
      [{ from: "ifNode", to: "B", branch: "then" }],
    );

    const result = builder.disconnect(draft, "ifNode", "B", "then");

    expect(result.edges).toHaveLength(0);
  });

  test("disconnect non-existent edge is a no-op", () => {
    const builder = new WorkflowBuilder(testConfig());
    const draft = makeDraft([makeStep("A", "agent"), makeStep("B", "agent")], []);

    const result = builder.disconnect(draft, "A", "B");

    expect(result).toBe(draft);
  });
});

// ---------------------------------------------------------------------------
// Immutability
// ---------------------------------------------------------------------------

describe("Immutability", () => {
  test("insertBetween does not mutate original draft", () => {
    const builder = new WorkflowBuilder(testConfig());
    const steps = [makeStep("A", "agent"), makeStep("B", "agent")];
    const edges: EdgeDraft[] = [{ from: "A", to: "B" }];
    const draft = makeDraft(steps, edges);

    builder.insertBetween(draft, "A", "B", "agent");

    expect(draft.steps).toHaveLength(2);
    expect(draft.edges).toHaveLength(1);
    expect(draft.edges[0]).toEqual({ from: "A", to: "B" });
  });

  test("remove does not mutate original draft", () => {
    const builder = new WorkflowBuilder(testConfig());
    const steps = [makeStep("A", "agent"), makeStep("X", "agent"), makeStep("B", "agent")];
    const edges: EdgeDraft[] = [
      { from: "A", to: "X" },
      { from: "X", to: "B" },
    ];
    const draft = makeDraft(steps, edges);

    builder.remove(draft, "X");

    expect(draft.steps).toHaveLength(3);
    expect(draft.edges).toHaveLength(2);
  });

  test("appendAfter does not mutate original draft", () => {
    const builder = new WorkflowBuilder(testConfig());
    const steps = [makeStep("A", "agent")];
    const edges: EdgeDraft[] = [];
    const draft = makeDraft(steps, edges);

    builder.appendAfter(draft, "A", "agent");

    expect(draft.steps).toHaveLength(1);
    expect(draft.edges).toHaveLength(0);
  });

  test("connect does not mutate original draft", () => {
    const builder = new WorkflowBuilder(testConfig());
    const steps = [makeStep("A", "agent"), makeStep("B", "agent")];
    const edges: EdgeDraft[] = [];
    const draft = makeDraft(steps, edges);

    builder.connect(draft, "A", "B");

    expect(draft.edges).toHaveLength(0);
  });

  test("disconnect does not mutate original draft", () => {
    const builder = new WorkflowBuilder(testConfig());
    const steps = [makeStep("A", "agent"), makeStep("B", "agent")];
    const edges: EdgeDraft[] = [{ from: "A", to: "B" }];
    const draft = makeDraft(steps, edges);

    builder.disconnect(draft, "A", "B");

    expect(draft.edges).toHaveLength(1);
  });
});
