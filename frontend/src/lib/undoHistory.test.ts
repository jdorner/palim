import { describe, expect, test } from "bun:test";
import { UndoHistory } from "./undoHistory";

/** History with a manually advanced clock. */
function makeHistory(options: { limit?: number; coalesceMs?: number } = {}) {
  let time = 0;
  const history = new UndoHistory<string>({ ...options, now: () => time });
  return {
    history,
    advance(ms: number) {
      time += ms;
    },
  };
}

describe("UndoHistory", () => {
  test("starts empty", () => {
    const { history } = makeHistory();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(history.undo("a")).toBeUndefined();
    expect(history.redo("a")).toBeUndefined();
  });

  test("undoes and redoes in order", () => {
    const { history } = makeHistory();
    history.record("a");
    history.record("b");
    // current state is "c"
    expect(history.undo("c")).toBe("b");
    expect(history.undo("b")).toBe("a");
    expect(history.canUndo).toBe(false);
    expect(history.redo("a")).toBe("b");
    expect(history.redo("b")).toBe("c");
    expect(history.canRedo).toBe(false);
  });

  test("a new record clears the redo stack", () => {
    const { history } = makeHistory();
    history.record("a");
    history.undo("b");
    expect(history.canRedo).toBe(true);
    history.record("a");
    expect(history.canRedo).toBe(false);
  });

  test("coalesces same-key records inside the window", () => {
    const { history, advance } = makeHistory({ coalesceMs: 1000 });
    history.record("", "prompt");
    advance(500);
    history.record("h", "prompt");
    advance(500);
    history.record("he", "prompt");
    expect(history.undo("hey")).toBe("");
    expect(history.canUndo).toBe(false);
  });

  test("does not coalesce across the window, different keys, or unkeyed records", () => {
    const { history, advance } = makeHistory({ coalesceMs: 1000 });
    history.record("a", "prompt");
    advance(1000);
    history.record("b", "prompt");
    history.record("c", "slug");
    history.record("d");
    history.record("e");
    expect(history.undo("f")).toBe("e");
    expect(history.undo("e")).toBe("d");
    expect(history.undo("d")).toBe("c");
    expect(history.undo("c")).toBe("b");
    expect(history.undo("b")).toBe("a");
  });

  test("breakCoalescing starts a new step", () => {
    const { history } = makeHistory();
    history.record("a", "prompt");
    history.breakCoalescing();
    history.record("b", "prompt");
    expect(history.undo("c")).toBe("b");
    expect(history.undo("b")).toBe("a");
  });

  test("undo ends a coalescing run", () => {
    const { history } = makeHistory();
    history.record("a", "prompt");
    history.record("b", "prompt");
    history.undo("c");
    history.record("a", "prompt");
    expect(history.undo("x")).toBe("a");
  });

  test("drops the oldest steps beyond the limit", () => {
    const { history } = makeHistory({ limit: 2 });
    history.record("a");
    history.record("b");
    history.record("c");
    expect(history.undo("d")).toBe("c");
    expect(history.undo("c")).toBe("b");
    expect(history.canUndo).toBe(false);
  });

  test("clear drops all history", () => {
    const { history } = makeHistory();
    history.record("a");
    history.record("b");
    history.undo("c");
    history.clear();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });
});
