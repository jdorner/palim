import { describe, expect, test } from "bun:test";
import { aggregateStepStatus } from "./utils";

describe("aggregateStepStatus", () => {
  describe("basic aggregation", () => {
    test("returns completed when every step completed", () => {
      expect(aggregateStepStatus([{ status: "completed" }, { status: "completed" }])).toBe("completed");
    });

    test("returns failed when any step failed", () => {
      expect(aggregateStepStatus([{ status: "completed" }, { status: "failed" }])).toBe("failed");
    });

    test("returns active when a step is active", () => {
      expect(aggregateStepStatus([{ status: "completed" }, { status: "active" }])).toBe("active");
    });

    test("returns waiting-signal when a step is waiting for a signal", () => {
      expect(aggregateStepStatus([{ status: "completed" }, { status: "waiting-signal" }])).toBe("waiting-signal");
    });

    test("returns waiting when a step is waiting or delayed", () => {
      expect(aggregateStepStatus([{ status: "completed" }, { status: "waiting" }])).toBe("waiting");
      expect(aggregateStepStatus([{ status: "completed" }, { status: "delayed" }])).toBe("waiting");
    });
  });

  describe("priority ordering", () => {
    test("failed outranks waiting-signal, active, and waiting", () => {
      expect(
        aggregateStepStatus([
          { status: "failed" },
          { status: "waiting-signal" },
          { status: "active" },
          { status: "waiting" },
        ]),
      ).toBe("failed");
    });

    test("waiting-signal outranks active and waiting", () => {
      expect(aggregateStepStatus([{ status: "waiting-signal" }, { status: "active" }, { status: "waiting" }])).toBe(
        "waiting-signal",
      );
    });

    test("active outranks waiting", () => {
      expect(aggregateStepStatus([{ status: "active" }, { status: "waiting" }])).toBe("active");
    });
  });

  describe("dead and skipped branches", () => {
    test("returns completed when a completed run has dead (not-taken branch) steps", () => {
      // A control-flow run that took one branch: the taken branch completed,
      // the other branch is dead. The run is fully successful and the dot
      // should be green (completed), not gray (unknown).
      expect(aggregateStepStatus([{ status: "completed" }, { status: "completed" }, { status: "dead" }])).toBe(
        "completed",
      );
    });

    test("returns completed when a completed run has skipped steps", () => {
      expect(aggregateStepStatus([{ status: "completed" }, { status: "skipped" }])).toBe("completed");
    });

    test("dead steps do not mask a real failure", () => {
      expect(aggregateStepStatus([{ status: "failed" }, { status: "dead" }])).toBe("failed");
    });

    test("dead steps do not mask an active step", () => {
      expect(aggregateStepStatus([{ status: "active" }, { status: "dead" }])).toBe("active");
    });

    test("returns unknown when all steps are dead (nothing actually ran)", () => {
      expect(aggregateStepStatus([{ status: "dead" }, { status: "dead" }])).toBe("unknown");
    });
  });

  describe("backend DAG vocabulary", () => {
    // The run list feeds raw DAG step statuses (running/pending/completed/
    // failed/dead), not the graph vocabulary (active/waiting/skipped).
    test("returns active when a step is running (blinking blue dot)", () => {
      expect(aggregateStepStatus([{ status: "running" }, { status: "pending" }])).toBe("active");
    });

    test("returns waiting when steps are only pending", () => {
      expect(aggregateStepStatus([{ status: "pending" }, { status: "pending" }])).toBe("waiting");
    });

    test("returns completed when a finished run has a dead branch", () => {
      expect(aggregateStepStatus([{ status: "completed" }, { status: "completed" }, { status: "dead" }])).toBe(
        "completed",
      );
    });

    test("returns failed when a DAG step failed", () => {
      expect(aggregateStepStatus([{ status: "completed" }, { status: "failed" }, { status: "dead" }])).toBe("failed");
    });

    test("running outranks a dead branch", () => {
      expect(aggregateStepStatus([{ status: "running" }, { status: "dead" }])).toBe("active");
    });
  });

  describe("edge cases", () => {
    test("returns unknown for an empty step list", () => {
      expect(aggregateStepStatus([])).toBe("unknown");
    });

    test("returns unknown for unrecognized statuses", () => {
      expect(aggregateStepStatus([{ status: "bogus" }])).toBe("unknown");
    });
  });
});
