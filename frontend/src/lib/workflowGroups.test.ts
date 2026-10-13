import { afterEach, describe, expect, test } from "bun:test";
import { groupWorkflows, readCollapsedGroups, sectionKey, sumRunCounts, writeCollapsedGroups } from "./workflowGroups";

type Wf = { name: string; group?: string };

describe("groupWorkflows", () => {
  test("sorts named groups and puts ungrouped workflows last", () => {
    const sections = groupWorkflows<Wf>([
      { name: "a", group: "Mail" },
      { name: "b" },
      { name: "c", group: "Finance" },
      { name: "d", group: "Mail" },
      { name: "e", group: "  " },
    ]);
    expect(sections.map((s) => [s.group, s.items.map((w) => w.name)])).toEqual([
      ["Finance", ["c"]],
      ["Mail", ["a", "d"]],
      [null, ["b", "e"]],
    ]);
  });

  test("returns a single ungrouped section when no workflow has a group", () => {
    expect(groupWorkflows<Wf>([{ name: "a" }, { name: "b" }])).toEqual([
      { group: null, items: [{ name: "a" }, { name: "b" }] },
    ]);
  });

  test("returns no sections for an empty list", () => {
    expect(groupWorkflows<Wf>([])).toEqual([]);
  });
});

describe("sumRunCounts", () => {
  test("sums the run counters", () => {
    expect(
      sumRunCounts([
        { activeRuns: 1, failedRuns: 0, completedRuns: 5 },
        { activeRuns: 2, failedRuns: 3, completedRuns: 7 },
      ]),
    ).toEqual({ activeRuns: 3, failedRuns: 3, completedRuns: 12 });
  });

  test("returns zeros for an empty section", () => {
    expect(sumRunCounts([])).toEqual({ activeRuns: 0, failedRuns: 0, completedRuns: 0 });
  });
});

describe("collapsed groups", () => {
  const original = globalThis.localStorage;
  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", { value: original, configurable: true });
  });

  test("round-trips through storage", () => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) },
      configurable: true,
    });
    writeCollapsedGroups(new Set(["Finance", sectionKey(null)]));
    expect(readCollapsedGroups()).toEqual(new Set(["Finance", ""]));
  });

  test("falls back to an empty set when storage throws", () => {
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      },
      configurable: true,
    });
    expect(() => writeCollapsedGroups(new Set(["x"]))).not.toThrow();
    expect(readCollapsedGroups()).toEqual(new Set());
  });
});
