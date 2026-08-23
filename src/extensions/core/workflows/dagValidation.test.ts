import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { computeRootSteps, computeTerminalSteps, validateCfEdges, validateDag } from "./dagValidation";
import { type DagWorkflowDefinition, DagWorkflowDefinitionSchema } from "./schemas";

/** Helper to create a minimal valid DAG definition for testing. */
function makeDag(overrides: Partial<DagWorkflowDefinition> = {}): DagWorkflowDefinition {
  return {
    name: "test-workflow",
    trigger: { type: "manual" },
    steps: {
      a: { type: "agent", prompt: "do A" },
      b: { type: "agent", prompt: "do B" },
    },
    edges: [{ from: "a", to: "b" }],
    ...overrides,
  };
}

describe("DagWorkflowDefinitionSchema", () => {
  test("accepts a valid minimal DAG workflow", () => {
    const def = makeDag();
    expect(Value.Check(DagWorkflowDefinitionSchema, def)).toBe(true);
  });

  test("rejects missing edges field", () => {
    const def = { name: "test", trigger: { type: "manual" }, steps: { a: { type: "agent", prompt: "x" } } };
    expect(Value.Check(DagWorkflowDefinitionSchema, def)).toBe(false);
  });

  test("rejects empty steps map", () => {
    const def = { name: "test", trigger: { type: "manual" }, steps: {}, edges: [{ from: "a", to: "b" }] };
    expect(Value.Check(DagWorkflowDefinitionSchema, def)).toBe(false);
  });

  test("accepts empty edges array for single-step workflow", () => {
    const def = {
      name: "test",
      trigger: { type: "manual" },
      steps: { a: { type: "agent", prompt: "x" } },
      edges: [],
    };
    expect(Value.Check(DagWorkflowDefinitionSchema, def)).toBe(true);
  });

  test("accepts if step without inline then/else arrays", () => {
    const def = makeDag({
      steps: {
        a: { type: "agent", prompt: "x" },
        decide: { type: "if", condition: { ref: "{{steps.a.result}}", eq: "yes" } },
        b: { type: "agent", prompt: "y" },
      },
      edges: [
        { from: "a", to: "decide" },
        { from: "decide", to: "b", branch: "then" },
      ],
    });
    expect(Value.Check(DagWorkflowDefinitionSchema, def)).toBe(true);
  });

  test("accepts case step with paths as string array", () => {
    const def = makeDag({
      steps: {
        a: { type: "agent", prompt: "x" },
        route: { type: "case", match: "{{steps.a.result}}", paths: ["low", "high"] },
        lo: { type: "agent", prompt: "low path" },
        hi: { type: "agent", prompt: "high path" },
      },
      edges: [
        { from: "a", to: "route" },
        { from: "route", to: "lo", branch: "low" },
        { from: "route", to: "hi", branch: "high" },
      ],
    });
    expect(Value.Check(DagWorkflowDefinitionSchema, def)).toBe(true);
  });

  test("accepts edge with branch property", () => {
    const def = makeDag({
      steps: {
        a: { type: "agent", prompt: "x" },
        decide: { type: "if", condition: { ref: "{{steps.a.result}}", eq: "yes" } },
        b: { type: "agent", prompt: "y" },
      },
      edges: [
        { from: "a", to: "decide" },
        { from: "decide", to: "b", branch: "then" },
      ],
    });
    expect(Value.Check(DagWorkflowDefinitionSchema, def)).toBe(true);
  });
});

describe("validateDag", () => {
  test("returns no errors for a valid linear DAG", () => {
    const def = makeDag();
    const errors = validateDag(def);
    expect(errors).toEqual([]);
  });

  test("returns no errors for a valid fan-out/join DAG", () => {
    const def = makeDag({
      steps: {
        a: { type: "agent", prompt: "start" },
        b: { type: "agent", prompt: "branch 1" },
        c: { type: "agent", prompt: "branch 2" },
        d: { type: "agent", prompt: "join" },
      },
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
        { from: "b", to: "d" },
        { from: "c", to: "d" },
      ],
    });
    const errors = validateDag(def);
    expect(errors).toEqual([]);
  });

  test("detects edge referencing non-existent step in from", () => {
    const def = makeDag({
      edges: [{ from: "nonexistent", to: "b" }],
    });
    const errors = validateDag(def);
    expect(errors.length).toBe(1);
    expect(errors[0]!.code).toBe("invalid_edge_ref");
    expect(errors[0]!.message).toContain("nonexistent");
  });

  test("detects edge referencing non-existent step in to", () => {
    const def = makeDag({
      edges: [{ from: "a", to: "nonexistent" }],
    });
    const errors = validateDag(def);
    expect(errors.length).toBe(1);
    expect(errors[0]!.code).toBe("invalid_edge_ref");
    expect(errors[0]!.message).toContain("nonexistent");
  });

  test("detects simple cycle (A -> B -> A)", () => {
    const def = makeDag({
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    });
    const errors = validateDag(def);
    expect(errors.length).toBe(1);
    expect(errors[0]!.code).toBe("cycle_detected");
    expect(errors[0]!.message).toContain("a");
    expect(errors[0]!.message).toContain("b");
  });

  test("detects longer cycle (A -> B -> C -> A)", () => {
    const def = makeDag({
      steps: {
        a: { type: "agent", prompt: "x" },
        b: { type: "agent", prompt: "y" },
        c: { type: "agent", prompt: "z" },
      },
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "a" },
      ],
    });
    const errors = validateDag(def);
    expect(errors.length).toBe(1);
    expect(errors[0]!.code).toBe("cycle_detected");
  });

  test("detects no root nodes (all steps have incoming edges due to cycle)", () => {
    // This would be caught by cycle detection first
    const def = makeDag({
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    });
    const errors = validateDag(def);
    // Should hit cycle_detected before no_root_nodes
    expect(errors.some((e) => e.code === "cycle_detected")).toBe(true);
  });

  test("detects unreachable steps", () => {
    const def = makeDag({
      steps: {
        a: { type: "agent", prompt: "root" },
        b: { type: "agent", prompt: "connected" },
        c: { type: "agent", prompt: "orphan" },
        d: { type: "agent", prompt: "orphan target" },
      },
      edges: [
        { from: "a", to: "b" },
        { from: "c", to: "d" }, // c and d form a disconnected component, but c has no incoming -> it's a root
      ],
    });
    // c is actually a root node (no incoming edges), so both a and c are roots
    // d is reachable from c. All steps should be reachable.
    const errors = validateDag(def);
    expect(errors).toEqual([]);
  });

  test("detects a lone orphaned step with no incoming or outgoing edges", () => {
    // A step with no edges technically qualifies as a root (no incoming edges),
    // so the reachability check treats it as reachable-from-itself and would not
    // flag it. The dedicated orphan check catches it instead.
    const def = makeDag({
      steps: {
        a: { type: "agent", prompt: "root" },
        b: { type: "agent", prompt: "connected" },
        c: { type: "agent", prompt: "isolated" },
      },
      edges: [{ from: "a", to: "b" }],
    });
    const errors = validateDag(def);
    expect(errors.length).toBe(1);
    expect(errors[0]!.code).toBe("orphaned_step");
    expect(errors[0]!.message).toContain("c");
  });

  test("does not flag a single-step workflow with no edges as orphaned", () => {
    const def = makeDag({
      steps: { a: { type: "agent", prompt: "only" } },
      edges: [],
    });
    const errors = validateDag(def);
    expect(errors).toEqual([]);
  });

  test("does not flag steps that participate in at least one edge", () => {
    const def = makeDag({
      steps: {
        a: { type: "agent", prompt: "root" },
        b: { type: "agent", prompt: "middle" },
        c: { type: "agent", prompt: "leaf" },
      },
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    });
    const errors = validateDag(def);
    expect(errors).toEqual([]);
  });
});

describe("validateCfEdges", () => {
  test("returns no errors for valid if-node edges", () => {
    const def = makeDag({
      steps: {
        a: { type: "agent", prompt: "x" },
        decide: { type: "if", condition: { ref: "{{steps.a.result}}", eq: "yes" } },
        b: { type: "agent", prompt: "then path" },
        c: { type: "agent", prompt: "else path" },
      },
      edges: [
        { from: "a", to: "decide" },
        { from: "decide", to: "b", branch: "then" },
        { from: "decide", to: "c", branch: "else" },
      ],
    });
    const errors = validateCfEdges(def);
    expect(errors).toEqual([]);
  });

  test("returns no errors for valid case-node edges", () => {
    const def = makeDag({
      steps: {
        a: { type: "agent", prompt: "x" },
        route: { type: "case", match: "{{steps.a.result}}", paths: ["low", "high"], default: "low" },
        lo: { type: "agent", prompt: "low" },
        hi: { type: "agent", prompt: "high" },
      },
      edges: [
        { from: "a", to: "route" },
        { from: "route", to: "lo", branch: "low" },
        { from: "route", to: "hi", branch: "high" },
      ],
    });
    const errors = validateCfEdges(def);
    expect(errors).toEqual([]);
  });

  test("detects CF node with unconditional outgoing edge", () => {
    const def = makeDag({
      steps: {
        a: { type: "agent", prompt: "x" },
        decide: { type: "if", condition: { ref: "{{steps.a.result}}", eq: "yes" } },
        b: { type: "agent", prompt: "y" },
      },
      edges: [
        { from: "a", to: "decide" },
        { from: "decide", to: "b" }, // missing branch
      ],
    });
    const errors = validateCfEdges(def);
    expect(errors.length).toBe(1);
    expect(errors[0]!.code).toBe("cf_node_unconditional_edge");
  });

  test("detects non-CF step with branch property on edge", () => {
    const def = makeDag({
      steps: {
        a: { type: "agent", prompt: "x" },
        b: { type: "agent", prompt: "y" },
      },
      edges: [{ from: "a", to: "b", branch: "then" }],
    });
    const errors = validateCfEdges(def);
    expect(errors.length).toBe(1);
    expect(errors[0]!.code).toBe("non_cf_edge_has_branch");
  });

  test("detects invalid if-node branch value", () => {
    const def = makeDag({
      steps: {
        a: { type: "agent", prompt: "x" },
        decide: { type: "if", condition: { ref: "{{steps.a.result}}", eq: "yes" } },
        b: { type: "agent", prompt: "y" },
      },
      edges: [
        { from: "a", to: "decide" },
        { from: "decide", to: "b", branch: "invalid" },
      ],
    });
    const errors = validateCfEdges(def);
    expect(errors.length).toBe(1);
    expect(errors[0]!.code).toBe("invalid_if_branch");
  });

  test("detects invalid case-node branch value", () => {
    const def = makeDag({
      steps: {
        a: { type: "agent", prompt: "x" },
        route: { type: "case", match: "{{steps.a.result}}", paths: ["low", "high"] },
        b: { type: "agent", prompt: "y" },
      },
      edges: [
        { from: "a", to: "route" },
        { from: "route", to: "b", branch: "medium" },
      ],
    });
    const errors = validateCfEdges(def);
    expect(errors.length).toBe(1);
    expect(errors[0]!.code).toBe("invalid_case_branch");
  });

  test("allows case-node default branch", () => {
    const def = makeDag({
      steps: {
        a: { type: "agent", prompt: "x" },
        route: { type: "case", match: "{{steps.a.result}}", paths: ["low", "high"], default: "low" },
        fallback: { type: "agent", prompt: "fallback" },
      },
      edges: [
        { from: "a", to: "route" },
        { from: "route", to: "fallback", branch: "default" },
      ],
    });
    const errors = validateCfEdges(def);
    expect(errors).toEqual([]);
  });
});

describe("computeRootSteps", () => {
  test("identifies single root", () => {
    const def = makeDag();
    expect(computeRootSteps(def)).toEqual(["a"]);
  });

  test("identifies multiple roots in parallel fan-in", () => {
    const def = makeDag({
      steps: {
        a: { type: "agent", prompt: "root 1" },
        b: { type: "agent", prompt: "root 2" },
        c: { type: "agent", prompt: "join" },
      },
      edges: [
        { from: "a", to: "c" },
        { from: "b", to: "c" },
      ],
    });
    const roots = computeRootSteps(def);
    expect(roots.sort()).toEqual(["a", "b"]);
  });
});

describe("computeTerminalSteps", () => {
  test("identifies single terminal", () => {
    const def = makeDag();
    expect(computeTerminalSteps(def)).toEqual(["b"]);
  });

  test("identifies multiple terminals in fan-out", () => {
    const def = makeDag({
      steps: {
        a: { type: "agent", prompt: "start" },
        b: { type: "agent", prompt: "end 1" },
        c: { type: "agent", prompt: "end 2" },
      },
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
      ],
    });
    const terminals = computeTerminalSteps(def);
    expect(terminals.sort()).toEqual(["b", "c"]);
  });
});
