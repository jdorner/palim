import { beforeEach, describe, expect, test } from "bun:test";
import type { Logger } from "@ext/types";
import type { DagWorkflowDefinition } from "./schemas";
import { createWorkflowFileIndex, type WorkflowFileIndex } from "./workflowFileIndex";

const def = (name: string, prompt = "hi") =>
  ({
    name,
    trigger: { type: "manual" },
    steps: { a: { type: "agent", prompt } },
    edges: [],
  }) as unknown as DagWorkflowDefinition;

/** The agent prompt of a stored workflow, or `undefined` if it is not loaded. */
const promptOf = (name: string) => (store.get(name)?.steps.a as { prompt: string } | undefined)?.prompt;

let store: Map<string, DagWorkflowDefinition>;
let index: WorkflowFileIndex;
let warnings: string[];

beforeEach(() => {
  store = new Map();
  warnings = [];
  const log = { debug() {}, info() {}, error() {}, warn: (m: string) => warnings.push(m) } as unknown as Logger;
  index = createWorkflowFileIndex(store, log);
  index.replaceAll([
    { file: "nightly.json5", definition: def("report") },
    { file: "other.json5", definition: def("other") },
  ]);
});

describe("createWorkflowFileIndex", () => {
  test("a changed file updates only its workflow", () => {
    const other = store.get("other");
    index.applyFile("nightly.json5", def("report", "changed"));
    expect(promptOf("report")).toBe("changed");
    expect(store.get("other")).toBe(other!);
  });

  test("an invalid or deleted file removes its workflow, even when the file name differs", () => {
    index.applyFile("nightly.json5", null);
    expect([...store.keys()]).toEqual(["other"]);
    // Removing again (the watcher after the DELETE route) is a no-op.
    index.applyFile("nightly.json5", null);
    expect([...store.keys()]).toEqual(["other"]);
  });

  test("renaming the workflow inside a file drops the old name", () => {
    index.applyFile("nightly.json5", def("daily-report"));
    expect([...store.keys()].sort()).toEqual(["daily-report", "other"]);
  });

  test("a new file adds its workflow", () => {
    index.applyFile("new.json5", def("fresh"));
    expect(store.has("fresh")).toBe(true);
  });

  test("a file reusing another file's name is skipped, like in a full scan", () => {
    index.applyFile("copy.json5", def("report", "copy"));
    expect(promptOf("report")).toBe("hi");
    expect(warnings).toHaveLength(1);
    // A file that took over a taken name loses its own previous workflow.
    index.applyFile("other.json5", def("report"));
    expect(store.has("other")).toBe(false);
    expect(promptOf("report")).toBe("hi");
  });

  test("replaceAll keeps the first of duplicate names", () => {
    index.replaceAll([
      { file: "a.json5", definition: def("x", "first") },
      { file: "b.json5", definition: def("x", "second") },
    ]);
    expect(promptOf("x")).toBe("first");
    expect(store.size).toBe(1);
  });
});
