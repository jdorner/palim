import { describe, expect, test } from "bun:test";
import { buildDagGraph, type DagEdge, type StepData } from "./workflowGraph";
import { computeLayout } from "./workflowLayout";

/**
 * Converts a slug-keyed step record into the ordered step array that
 * `buildDagGraph` expects. These layout tests use slug-based identity (no
 * synthetic ids), so the slug doubles as the node id and edges stay slug-based.
 */
function toStepArray(steps: Record<string, Record<string, unknown>>): StepData[] {
  return Object.entries(steps).map(([slug, s]) => ({ slug, ...s }) as StepData);
}

/**
 * Builds a `case` node fanning out to `branches.length` sandbox-exec targets,
 * mirroring the "sort-by-category" workflow from the UI (many branches).
 * Each branch routes to its own `move-<branch>` target node.
 */
function buildCaseGraph(branches: string[]) {
  const steps: Record<string, Record<string, unknown>> = {
    categorize: { type: "agent", prompt: "classify" },
    sort: { type: "case", match: "{{steps.categorize.result}}", paths: branches },
  };
  const edges: DagEdge[] = [{ from: "categorize", to: "sort" }];

  for (const branch of branches) {
    const target = `move-${branch}`;
    steps[target] = { type: "sandbox-exec", command: "mv" };
    edges.push({ from: "sort", to: target, branch });
  }

  return buildDagGraph(toStepArray(steps), edges);
}

describe("computeLayout", () => {
  describe("branch edges", () => {
    const branches = ["a", "b", "c", "d", "e", "f", "default"];
    const graph = buildCaseGraph(branches);
    const layout = computeLayout(graph, {});

    test("emits exactly one edge per branch", () => {
      const branchEdges = layout.edges.filter((e) => e.source === "sort");
      expect(branchEdges).toHaveLength(branches.length);
    });

    test("branch edges are curved (default bezier, not smoothstep)", () => {
      const branchEdges = layout.edges.filter((e) => e.source === "sort");
      for (const edge of branchEdges) {
        expect(edge.type).toBeUndefined();
      }
    });

    test("each branch edge leaves from a distinct source handle and targets a distinct node", () => {
      const branchEdges = layout.edges.filter((e) => e.source === "sort");
      expect(new Set(branchEdges.map((e) => e.sourceHandle)).size).toBe(branches.length);
      expect(new Set(branchEdges.map((e) => e.target)).size).toBe(branches.length);
    });

    test("branch target nodes are laid out at distinct vertical positions", () => {
      const targetIds = branches.map((b) => `move-${b}`);
      const ys = layout.nodes.filter((n) => targetIds.includes(n.id)).map((n) => Math.round(n.position.y));
      expect(new Set(ys).size).toBe(branches.length);
    });

    test("each branch edge carries its branch label", () => {
      for (const branch of branches) {
        const edge = layout.edges.find((e) => e.source === "sort" && e.target === `move-${branch}`)!;
        expect(edge.label).toBe(branch);
      }
    });
  });

  describe("add-step nodes (edit mode)", () => {
    describe("populated branches", () => {
      // Regression: previously every branch spawned a spurious "empty branch"
      // addStep node directly off the case node (because branch membership was
      // read from node.parent, which is always null in the DAG model). Branches
      // that already route to a target must NOT get a duplicate empty addStep.
      const branches = ["a", "b", "c", "default"];
      const graph = buildCaseGraph(branches);
      const layout = computeLayout(graph, { includeAddNode: true });

      test("does not create empty-branch addStep edges straight from the case node", () => {
        // An empty-branch addStep edge would originate at "sort" and carry a
        // branch label. Populated branches must have none.
        const emptyBranchEdges = layout.edges.filter((e) => e.source === "sort" && e.id.includes("__addStep:"));
        expect(emptyBranchEdges).toHaveLength(0);
      });

      test("addStep nodes hang off each branch tail, not the case node", () => {
        const addStepNodes = layout.nodes.filter((n) => n.id.startsWith("__addStep:"));
        // One addStep per branch tail (targets are sandbox-exec, which is not terminal here).
        expect(addStepNodes).toHaveLength(branches.length);
        // Each addStep edge sources from a move-* tail, never directly from "sort".
        const addStepEdges = layout.edges.filter((e) => e.target.startsWith("__addStep:"));
        for (const edge of addStepEdges) {
          expect(edge.source.startsWith("move-")).toBe(true);
        }
      });
    });

    describe("root add-step", () => {
      test("carries sourceNodeId pointing at the tail of the main chain so new steps attach", () => {
        // Regression: the root "+" produced a new step with no connecting edge,
        // leaving it detached from the graph. The root add-step node must stamp
        // the main-chain tail as sourceNodeId so the caller can wire the edge.
        const steps: Record<string, Record<string, unknown>> = {
          first: { type: "agent", prompt: "a" },
          second: { type: "agent", prompt: "b" },
        };
        const edges: DagEdge[] = [{ from: "first", to: "second" }];
        const graph = buildDagGraph(toStepArray(steps), edges);
        const layout = computeLayout(graph, { includeAddNode: true });

        const rootAddStep = layout.nodes.find((n) => n.id === "__addStep__");
        expect(rootAddStep).not.toBeUndefined();
        expect(rootAddStep!.data.sourceNodeId).toBe("second");
      });
    });

    describe("empty branches", () => {
      test("an if-node's unconnected branch gets an addStep directly off the if node", () => {
        // "if" nodes always expose then/else. Here "else" has no target -> empty.
        const steps: Record<string, Record<string, unknown>> = {
          decide: { type: "if", condition: { ref: "{{x}}", eq: "y" } },
          "on-then": { type: "sandbox-exec", command: "mv" },
        };
        const edges: DagEdge[] = [{ from: "decide", to: "on-then", branch: "then" }];
        const graph = buildDagGraph(toStepArray(steps), edges);
        const layout = computeLayout(graph, { includeAddNode: true });

        // The empty "else" branch produces an addStep edge sourced at "decide".
        const emptyBranchEdge = layout.edges.find(
          (e) => e.source === "decide" && e.target.includes(":else__") && e.label === "else",
        );
        expect(emptyBranchEdge).not.toBeUndefined();

        // The connected "then" branch's addStep hangs off its tail, not "decide".
        const thenAddStep = layout.edges.find((e) => e.target.includes(":then__"));
        expect(thenAddStep?.source).toBe("on-then");
      });

      test("if node with custom branch labels does NOT spawn trailing add-steps on populated branches", () => {
        // Regression: overriding an if node's then/else edge labels made the
        // layout match branches by display label instead of the canonical key,
        // so populated branches looked "empty" and each grew a spurious
        // CF -> addStep placeholder edge. Both branches here have targets, so
        // the ONLY add-steps must hang off the branch tails, never off "decide".
        const steps: Record<string, Record<string, unknown>> = {
          decide: {
            type: "if",
            condition: { ref: "{{x}}", eq: "y" },
            // biome-ignore lint/suspicious/noThenProperty: "then" is the workflow branch keyword, not a thenable
            branchLabels: { then: "Edge 1", else: "Edge 2" },
          },
          "on-then": { type: "agent", prompt: "t" },
          "on-else": { type: "agent", prompt: "e" },
        };
        const edges: DagEdge[] = [
          { from: "decide", to: "on-then", branch: "then" },
          { from: "decide", to: "on-else", branch: "else" },
        ];
        const graph = buildDagGraph(toStepArray(steps), edges);
        const layout = computeLayout(graph, { includeAddNode: true });

        // No add-step edge may originate directly from the if node: both
        // branches are populated, so no empty-branch placeholder should exist.
        const addStepFromDecide = layout.edges.filter((e) => e.source === "decide" && e.target.startsWith("__addStep"));
        expect(addStepFromDecide).toHaveLength(0);

        // The add-steps that DO exist hang off the branch tails.
        const addStepSources = layout.edges
          .filter((e) => e.target.startsWith("__addStep"))
          .map((e) => e.source)
          .sort();
        expect(addStepSources).toEqual(["on-else", "on-then"]);

        // The real branch edges still carry the custom display labels.
        const thenEdge = layout.edges.find((e) => e.source === "decide" && e.target === "on-then");
        const elseEdge = layout.edges.find((e) => e.source === "decide" && e.target === "on-else");
        expect(thenEdge?.label).toBe("Edge 1");
        expect(elseEdge?.label).toBe("Edge 2");
      });
    });

    describe("terminal branch tails", () => {
      test("no addStep is added after a terminal step", () => {
        const steps: Record<string, Record<string, unknown>> = {
          sort: { type: "case", match: "{{x}}", paths: ["a"] },
          "fail-a": { type: "fail" },
        };
        const edges: DagEdge[] = [{ from: "sort", to: "fail-a", branch: "a" }];
        const graph = buildDagGraph(toStepArray(steps), edges);
        const layout = computeLayout(graph, {
          includeAddNode: true,
          terminalTypes: new Set(["fail"]),
        });

        const addStepNodes = layout.nodes.filter((n) => n.id.startsWith("__addStep:"));
        expect(addStepNodes).toHaveLength(0);
      });
    });
  });

  describe("join nodes (branches converging on a common follow-up)", () => {
    /**
     * Builds a case node whose first two branches converge on a shared `join`
     * node, plus a third independent branch. Mirrors the reported bug where
     * connecting two branch tails to one follow-up node produced duplicate/
     * dangling add-step nodes and flung the follow-up node far away.
     */
    function buildJoinGraph() {
      const steps: Record<string, Record<string, unknown>> = {
        sort: { type: "case", match: "{{x}}", paths: ["a", "b", "c"] },
        "move-a": { type: "sandbox-exec", command: "mv" },
        "move-b": { type: "sandbox-exec", command: "mv" },
        "move-c": { type: "sandbox-exec", command: "mv" },
        join: { type: "agent", prompt: "merge" },
      };
      const edges: DagEdge[] = [
        { from: "sort", to: "move-a", branch: "a" },
        { from: "sort", to: "move-b", branch: "b" },
        { from: "sort", to: "move-c", branch: "c" },
        { from: "move-a", to: "join" },
        { from: "move-b", to: "join" },
      ];
      return buildDagGraph(toStepArray(steps), edges);
    }

    test("the shared join node gets exactly one addStep, not one per incoming branch", () => {
      const layout = computeLayout(buildJoinGraph(), { includeAddNode: true });
      const joinAddStepEdges = layout.edges.filter((e) => e.source === "join" && e.target.startsWith("__addStep:"));
      expect(joinAddStepEdges).toHaveLength(1);
    });

    test("no addStep edge sources from a node that feeds into the join", () => {
      // move-a and move-b flow into join; their addStep must live after the
      // join, not dangling off the individual branch tails.
      const layout = computeLayout(buildJoinGraph(), { includeAddNode: true });
      const addStepSources = layout.edges.filter((e) => e.target.startsWith("__addStep:")).map((e) => e.source);
      expect(addStepSources).not.toContain("move-a");
      expect(addStepSources).not.toContain("move-b");
    });

    test("the independent branch keeps its own addStep", () => {
      const layout = computeLayout(buildJoinGraph(), { includeAddNode: true });
      const cAddStep = layout.edges.find((e) => e.source === "move-c" && e.target.startsWith("__addStep:"));
      expect(cAddStep).not.toBeUndefined();
    });

    test("the join node is vertically centered on the branches feeding it", () => {
      const layout = computeLayout(buildJoinGraph(), {});
      const y = (id: string) => layout.nodes.find((n) => n.id === id)!.position.y;
      const feederMid = (y("move-a") + y("move-b")) / 2;
      // The join node should sit within one node-height of its feeders' midpoint,
      // not flung to the far end of the fan-out.
      expect(Math.abs(y("join") - feederMid)).toBeLessThan(56);
    });

    test("converging branches do not stack/overlap vertically", () => {
      const layout = computeLayout(buildJoinGraph(), {});
      const ys = ["move-a", "move-b", "move-c"].map((id) => layout.nodes.find((n) => n.id === id)!.position.y);
      const sorted = [...ys].sort((p, q) => p - q);
      for (let i = 0; i < sorted.length - 1; i++) {
        // Adjacent branch targets must be separated by at least a node height.
        expect(sorted[i + 1]! - sorted[i]!).toBeGreaterThanOrEqual(56);
      }
    });

    test("the join node's addStep is anchored next to the join, not flung away", () => {
      // Regression: recentering the join node onto its feeders happened AFTER
      // dagre placed the addStep, leaving the "+" button detached far from the
      // node its dashed edge originates from.
      const layout = computeLayout(buildJoinGraph(), { includeAddNode: true });
      const joinEdge = layout.edges.find((e) => e.source === "join" && e.target.startsWith("__addStep:"))!;
      expect(joinEdge).not.toBeUndefined();

      const join = layout.nodes.find((n) => n.id === "join")!;
      const addStep = layout.nodes.find((n) => n.id === joinEdge.target)!;

      // Nodes are positioned by their top-left corner, offset from the dagre
      // center by half the node's height. The add-step's center Y (position.y +
      // 32/2) must equal the join's center Y (position.y + 56/2) so the
      // connecting edge stays horizontal.
      const joinCenter = join.position.y + 56 / 2;
      const addStepCenter = addStep.position.y + 32 / 2;
      expect(Math.abs(addStepCenter - joinCenter)).toBeLessThan(1);
      // Positioned to the right of the join, roughly one node-width + rank gap
      // away (attached), not flung across the canvas.
      expect(addStep.position.x).toBeGreaterThan(join.position.x);
      expect(addStep.position.x - join.position.x).toBeLessThan(260);
    });
  });

  describe("sequential edges", () => {
    test("non-branch edges have no source handle and use the default renderer", () => {
      const steps = {
        a: { type: "agent", prompt: "x" },
        b: { type: "agent", prompt: "y" },
      };
      const graph = buildDagGraph(toStepArray(steps), [{ from: "a", to: "b" }]);
      const layout = computeLayout(graph, {});

      const seqEdge = layout.edges.find((e) => e.source === "a" && e.target === "b")!;
      expect(seqEdge).not.toBeUndefined();
      expect(seqEdge.type).toBeUndefined();
      expect(seqEdge.sourceHandle).toBeUndefined();
    });
  });
});
