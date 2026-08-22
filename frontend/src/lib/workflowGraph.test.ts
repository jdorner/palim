import { describe, expect, test } from "bun:test";
import { buildDagGraph, type DagEdge } from "./workflowGraph";

describe("buildDagGraph", () => {
  test("maps steps map to nodes and edges array to edges", () => {
    const steps = {
      a: { type: "agent", prompt: "x" },
      b: { type: "agent", prompt: "y" },
    };
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

  test("if-node branch edges use `{node}-{branch}` handle IDs", () => {
    const steps = {
      decide: { type: "if", condition: { ref: "{{steps.x.result}}", eq: "yes" } },
      yes: { type: "agent", prompt: "y" },
      no: { type: "agent", prompt: "n" },
    };
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
    const steps = {
      route: { type: "case", match: "{{steps.x.result}}", paths: ["low", "high"], default: "low" },
      lo: { type: "agent", prompt: "l" },
      hi: { type: "agent", prompt: "h" },
      fb: { type: "agent", prompt: "f" },
    };
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
