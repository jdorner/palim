import { describe, expect, test } from "bun:test";
import { buildDagGraph, type DagEdge, type StepData } from "./workflowGraph";

describe("buildDagGraph", () => {
  test("maps a step array to nodes and an edge array to edges", () => {
    // Run-view style: no synthetic id, so identity falls back to slug and edges
    // are slug-based (slugs are always valid/unique in a saved definition).
    const steps: StepData[] = [
      { slug: "a", type: "agent", prompt: "x" },
      { slug: "b", type: "agent", prompt: "y" },
    ];
    const edges: DagEdge[] = [{ from: "a", to: "b" }];

    const graph = buildDagGraph(steps, edges);

    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(graph.nodes[0]!.data.slug).toBe("a");
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.source).toBe("a");
    expect(graph.edges[0]!.target).toBe("b");
    expect(graph.edges[0]!.sourceHandle).toBeUndefined();
    expect(graph.edges[0]!.label).toBeUndefined();
  });

  describe("synthetic node ids", () => {
    test("node identity uses the synthetic id, not the slug", () => {
      const steps: StepData[] = [
        { id: "node-1", slug: "a", type: "agent", prompt: "x" },
        { id: "node-2", slug: "b", type: "agent", prompt: "y" },
      ];
      const graph = buildDagGraph(steps, [{ from: "node-1", to: "node-2" }]);

      expect(graph.nodes.map((n) => n.id).sort()).toEqual(["node-1", "node-2"]);
      // The slug is still carried in node data for labels/persistence.
      const nodeA = graph.nodes.find((n) => n.id === "node-1")!;
      expect(nodeA.data.slug).toBe("a");
      expect(nodeA.data.id).toBe("node-1");
    });

    test("id-based edge endpoints pass through unchanged", () => {
      const steps: StepData[] = [
        { id: "node-1", slug: "a", type: "agent", prompt: "x" },
        { id: "node-2", slug: "b", type: "agent", prompt: "y" },
      ];
      const graph = buildDagGraph(steps, [{ from: "node-1", to: "node-2" }]);

      expect(graph.edges).toHaveLength(1);
      expect(graph.edges[0]!.source).toBe("node-1");
      expect(graph.edges[0]!.target).toBe("node-2");
      expect(graph.edges[0]!.id).toBe("node-1->node-2");
    });

    test("two steps with the same empty slug each keep a distinct node", () => {
      // Reproduces the reported bug: both A and B have their slug cleared. A
      // slug-keyed model would collapse them into one node; the id-based model
      // keeps both, with their connecting edge intact.
      const steps: StepData[] = [
        { id: "node-1", slug: "", type: "agent", prompt: "x" },
        { id: "node-2", slug: "", type: "agent", prompt: "y" },
      ];
      const graph = buildDagGraph(steps, [{ from: "node-1", to: "node-2" }]);

      expect(graph.nodes.map((n) => n.id).sort()).toEqual(["node-1", "node-2"]);
      expect(graph.edges).toHaveLength(1);
      expect(graph.edges[0]!.source).toBe("node-1");
      expect(graph.edges[0]!.target).toBe("node-2");
    });

    test("branch handle ids are prefixed with the synthetic source id", () => {
      const steps: StepData[] = [
        { id: "node-9", slug: "decide", type: "if", condition: { ref: "{{x}}", eq: "y" } },
        { id: "node-10", slug: "yes", type: "agent", prompt: "y" },
      ];
      const graph = buildDagGraph(steps, [{ from: "node-9", to: "node-10", branch: "then" }]);

      const thenEdge = graph.edges.find((e) => e.target === "node-10")!;
      expect(thenEdge.source).toBe("node-9");
      expect(thenEdge.sourceHandle).toBe("node-9-then");
      expect(thenEdge.label).toBe("then");
    });

    test("edges referencing an unknown node id are dropped", () => {
      const steps: StepData[] = [{ id: "node-1", slug: "a", type: "agent", prompt: "x" }];
      // "ghost" is not a known node id; its edge should be skipped, not crash.
      const graph = buildDagGraph(steps, [{ from: "node-1", to: "ghost" }]);
      expect(graph.edges).toHaveLength(0);
    });
  });

  test("if-node branch edges use `{node}-{branch}` handle IDs", () => {
    const steps: StepData[] = [
      { slug: "decide", type: "if", condition: { ref: "{{steps.x.result}}", eq: "yes" } },
      { slug: "yes", type: "agent", prompt: "y" },
      { slug: "no", type: "agent", prompt: "n" },
    ];
    const edges: DagEdge[] = [
      { from: "decide", to: "yes", branch: "then" },
      { from: "decide", to: "no", branch: "else" },
    ];

    const graph = buildDagGraph(steps, edges);

    const thenEdge = graph.edges.find((e) => e.target === "yes")!;
    const elseEdge = graph.edges.find((e) => e.target === "no")!;
    expect(thenEdge.sourceHandle).toBe("decide-then");
    expect(thenEdge.label).toBe("then");
    expect(elseEdge.sourceHandle).toBe("decide-else");
  });

  test("case-node path edges use `{node}-path-{branch}` handle IDs", () => {
    const steps: StepData[] = [
      { slug: "route", type: "case", match: "{{steps.x.result}}", paths: ["low", "high"], default: "low" },
      { slug: "lo", type: "agent", prompt: "l" },
      { slug: "hi", type: "agent", prompt: "h" },
      { slug: "fb", type: "agent", prompt: "f" },
    ];
    const edges: DagEdge[] = [
      { from: "route", to: "lo", branch: "low" },
      { from: "route", to: "hi", branch: "high" },
      { from: "route", to: "fb", branch: "default" },
    ];

    const graph = buildDagGraph(steps, edges);

    const lowEdge = graph.edges.find((e) => e.target === "lo")!;
    const highEdge = graph.edges.find((e) => e.target === "hi")!;
    const defaultEdge = graph.edges.find((e) => e.target === "fb")!;

    // Path branches get the "path-" prefix to match ControlFlowNode handle IDs
    expect(lowEdge.sourceHandle).toBe("route-path-low");
    expect(highEdge.sourceHandle).toBe("route-path-high");
    // Default branch does NOT get the "path-" prefix
    expect(defaultEdge.sourceHandle).toBe("route-default");
  });
});
