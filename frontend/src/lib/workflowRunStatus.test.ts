import { describe, expect, test } from "bun:test";
import {
  type AnimatableEdge,
  buildStatusMap,
  computeDeadSteps,
  type DefinitionEdge,
  isEdgeAnimated,
  normalizeStepStatus,
  type StatusNode,
} from "./workflowRunStatus";

describe("normalizeStepStatus", () => {
  describe("backend vocabulary mapping", () => {
    test("maps running to active so the node highlights and its edge animates", () => {
      expect(normalizeStepStatus("running")).toBe("active");
    });

    test("maps pending to waiting", () => {
      expect(normalizeStepStatus("pending")).toBe("waiting");
    });

    test("maps dead to skipped", () => {
      expect(normalizeStepStatus("dead")).toBe("skipped");
    });
  });

  describe("graph vocabulary passthrough", () => {
    test("passes through statuses already in the graph vocabulary", () => {
      expect(normalizeStepStatus("waiting")).toBe("waiting");
      expect(normalizeStepStatus("active")).toBe("active");
      expect(normalizeStepStatus("completed")).toBe("completed");
      expect(normalizeStepStatus("failed")).toBe("failed");
      expect(normalizeStepStatus("waiting-signal")).toBe("waiting-signal");
      expect(normalizeStepStatus("skipped")).toBe("skipped");
    });
  });

  describe("edge cases", () => {
    test("falls back to waiting for unknown statuses", () => {
      expect(normalizeStepStatus("bogus")).toBe("waiting");
      expect(normalizeStepStatus("")).toBe("waiting");
    });
  });
});

describe("buildStatusMap", () => {
  describe("basic mapping", () => {
    test("normalizes each run step status by slug", () => {
      const map = buildStatusMap(
        [
          { slug: "a", status: "completed" },
          { slug: "b", status: "running" },
          { slug: "c", status: "pending" },
        ],
        "running",
        ["a", "b", "c"],
      );
      expect(map).toEqual({ a: "completed", b: "active", c: "waiting" });
    });

    test("regression: first running step resolves to active", () => {
      // Reproduces the reported bug: on run start the first step arrives as
      // "running" from the API and must render as active (yellow highlight)
      // so its incoming trigger edge animates.
      const map = buildStatusMap([{ slug: "create-motd", status: "running" }], "running", ["create-motd"]);
      expect(map["create-motd"]).toBe("active");
    });
  });

  describe("unexecuted definition steps", () => {
    test("marks steps absent from the run as skipped once the run completed", () => {
      const map = buildStatusMap([{ slug: "a", status: "completed" }], "completed", ["a", "b"]);
      expect(map.a).toBe("completed");
      expect(map.b).toBe("skipped");
    });

    test("marks steps absent from the run as skipped once the run failed", () => {
      const map = buildStatusMap([{ slug: "a", status: "failed" }], "failed", ["a", "b"]);
      expect(map.b).toBe("skipped");
    });

    test("leaves not-yet-reached steps absent while the run is still running", () => {
      const map = buildStatusMap([{ slug: "a", status: "running" }], "running", ["a", "b"]);
      expect(map.a).toBe("active");
      expect(map.b).toBeUndefined();
    });
  });

  describe("edge cases", () => {
    test("returns an empty map for a run with no steps and no definition", () => {
      expect(buildStatusMap([], "running", [])).toEqual({});
    });

    test("does not overwrite an executed step with skipped", () => {
      const map = buildStatusMap([{ slug: "a", status: "completed" }], "completed", ["a"]);
      expect(map.a).toBe("completed");
    });
  });
});

describe("isEdgeAnimated", () => {
  const nodes: StatusNode[] = [
    { id: "__trigger__", status: "completed" },
    { id: "create-motd", status: "active" },
    { id: "send", status: "waiting" },
  ];

  describe("active target", () => {
    test("animates the trigger edge when the first step is active", () => {
      const triggerEdge: AnimatableEdge = { source: "__trigger__", target: "create-motd" };
      expect(isEdgeAnimated(triggerEdge, nodes)).toBe(true);
    });
  });

  describe("inactive target", () => {
    test("does not animate an edge whose target is waiting", () => {
      const edge: AnimatableEdge = { source: "create-motd", target: "send" };
      expect(isEdgeAnimated(edge, nodes)).toBe(false);
    });

    test("does not animate when the target node is missing", () => {
      const edge: AnimatableEdge = { source: "create-motd", target: "nonexistent" };
      expect(isEdgeAnimated(edge, nodes)).toBe(false);
    });
  });

  describe("pre-flagged edges", () => {
    test("preserves an already-animated edge even when the target is not active", () => {
      const dashedAddStepEdge: AnimatableEdge = { source: "create-motd", target: "send", animated: true };
      expect(isEdgeAnimated(dashedAddStepEdge, nodes)).toBe(true);
    });
  });

  describe("join node fed by one live and several skipped branches", () => {
    // Only the edge from the branch that actually ran should animate, even
    // though the join target is active and every branch points at it.
    const joinNodes: StatusNode[] = [
      { id: "sort", status: "completed" },
      { id: "taken", status: "completed" },
      { id: "skipped-a", status: "skipped" },
      { id: "skipped-b", status: "skipped" },
      { id: "join", status: "active" },
    ];

    test("animates the edge from the live (completed) branch", () => {
      expect(isEdgeAnimated({ source: "taken", target: "join" }, joinNodes)).toBe(true);
    });

    test("does not animate edges from skipped branches", () => {
      expect(isEdgeAnimated({ source: "skipped-a", target: "join" }, joinNodes)).toBe(false);
      expect(isEdgeAnimated({ source: "skipped-b", target: "join" }, joinNodes)).toBe(false);
    });
  });
});

describe("computeDeadSteps", () => {
  const edges: DefinitionEdge[] = [
    { from: "sort", to: "a", branch: "x" },
    { from: "sort", to: "b", branch: "y" },
    { from: "sort", to: "c", branch: "z" },
    { from: "a", to: "join" },
    { from: "b", to: "join" },
    { from: "c", to: "join" },
  ];

  test("returns empty when no branch has been chosen yet", () => {
    expect(computeDeadSteps(edges, {}).size).toBe(0);
  });

  test("marks non-chosen branch targets dead once a branch is chosen", () => {
    const dead = computeDeadSteps(edges, { sort: "y" });
    expect(dead.has("a")).toBe(true);
    expect(dead.has("c")).toBe(true);
    expect(dead.has("b")).toBe(false);
  });

  test("does not mark a join node dead while one live branch still reaches it", () => {
    const dead = computeDeadSteps(edges, { sort: "y" });
    expect(dead.has("join")).toBe(false);
  });

  test("propagates deadness through a dead branch's own chain", () => {
    const chain: DefinitionEdge[] = [
      { from: "sort", to: "a", branch: "x" },
      { from: "sort", to: "b", branch: "y" },
      { from: "a", to: "a2" },
      { from: "a2", to: "a3" },
    ];
    const dead = computeDeadSteps(chain, { sort: "y" });
    expect(dead.has("a")).toBe(true);
    expect(dead.has("a2")).toBe(true);
    expect(dead.has("a3")).toBe(true);
  });
});

describe("buildStatusMap with dead-branch derivation", () => {
  const edges: DefinitionEdge[] = [
    { from: "sort", to: "taken", branch: "y" },
    { from: "sort", to: "skipped-a", branch: "x" },
    { from: "sort", to: "skipped-b", branch: "z" },
    { from: "taken", to: "join" },
    { from: "skipped-a", to: "join" },
    { from: "skipped-b", to: "join" },
  ];
  const slugs = ["sort", "taken", "skipped-a", "skipped-b", "join"];

  test("marks not-taken branches skipped live during a running run", () => {
    const map = buildStatusMap(
      [
        { slug: "sort", status: "completed" },
        { slug: "taken", status: "completed" },
        { slug: "join", status: "running" },
      ],
      "running",
      slugs,
      edges,
      { sort: "y" },
    );
    expect(map["skipped-a"]).toBe("skipped");
    expect(map["skipped-b"]).toBe("skipped");
    expect(map.taken).toBe("completed");
    expect(map.join).toBe("active");
  });

  test("does not skip branches before the case node has decided", () => {
    const map = buildStatusMap([{ slug: "sort", status: "active" }], "running", slugs, edges, {});
    expect(map["skipped-a"]).toBeUndefined();
    expect(map["skipped-b"]).toBeUndefined();
    expect(map.taken).toBeUndefined();
  });
});
