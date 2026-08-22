import { describe, expect, test } from "bun:test";
import {
  type AnimatableEdge,
  buildStatusMap,
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
      const triggerEdge: AnimatableEdge = { target: "create-motd" };
      expect(isEdgeAnimated(triggerEdge, nodes)).toBe(true);
    });
  });

  describe("inactive target", () => {
    test("does not animate an edge whose target is waiting", () => {
      const edge: AnimatableEdge = { target: "send" };
      expect(isEdgeAnimated(edge, nodes)).toBe(false);
    });

    test("does not animate when the target node is missing", () => {
      const edge: AnimatableEdge = { target: "nonexistent" };
      expect(isEdgeAnimated(edge, nodes)).toBe(false);
    });
  });

  describe("pre-flagged edges", () => {
    test("preserves an already-animated edge even when the target is not active", () => {
      const dashedAddStepEdge: AnimatableEdge = { target: "send", animated: true };
      expect(isEdgeAnimated(dashedAddStepEdge, nodes)).toBe(true);
    });
  });
});
