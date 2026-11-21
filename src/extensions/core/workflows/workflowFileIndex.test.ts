import { beforeEach, describe, expect, test } from "bun:test";
import type { Logger } from "@ext/types";
import type { DagWorkflowDefinition } from "./schemas";
import { createWorkflowFileIndex, missingWorkflowMessage, type WorkflowFileIndex } from "./workflowFileIndex";

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

  test("renaming a file works when the watcher reports the new file before the old one is gone", () => {
    index.applyFile("nightly2.json5", def("report", "moved"));
    expect(promptOf("report")).toBe("hi");
    index.applyFile("nightly.json5", null);
    expect(promptOf("report")).toBe("moved");
    expect(index.loadErrors()).toEqual([]);
    // The old file is gone for good: reporting it again changes nothing.
    index.applyFile("nightly.json5", null);
    expect(promptOf("report")).toBe("moved");
  });

  test("renaming a file works when the watcher reports the old file gone first", () => {
    index.applyFile("nightly.json5", null);
    index.applyFile("nightly2.json5", def("report", "moved"));
    expect(promptOf("report")).toBe("moved");
    expect(index.loadErrors()).toEqual([]);
  });

  test("deleting the original loads the first of two duplicates, the other stays a duplicate of it", () => {
    index.applyFile("z-copy.json5", def("report", "z"));
    index.applyFile("b-copy.json5", def("report", "b"));
    index.applyFile("nightly.json5", null);
    expect(promptOf("report")).toBe("b");
    expect(index.loadErrors()).toEqual([
      {
        file: "z-copy.json5",
        name: "report",
        error: 'Duplicate workflow name "report" (already defined in b-copy.json5)',
      },
    ]);
    index.applyFile("b-copy.json5", null);
    expect(promptOf("report")).toBe("z");
    expect(index.loadErrors()).toEqual([]);
  });

  test("a duplicate takes over when the original renames its workflow or breaks", () => {
    index.applyFile("copy.json5", def("report", "copy"));
    index.applyFile("nightly.json5", def("daily-report"));
    expect(promptOf("report")).toBe("copy");
    expect(store.has("daily-report")).toBe(true);

    index.applyFile("again.json5", def("other", "again"));
    index.applyFile("other.json5", null, { file: "other.json5", name: "other", error: "broken" });
    expect(promptOf("other")).toBe("again");
  });

  test("a skipped duplicate that changes or goes away no longer waits for the name", () => {
    index.applyFile("copy.json5", def("report", "copy"));
    index.applyFile("copy.json5", def("own"));
    index.applyFile("gone.json5", def("report", "gone"));
    index.applyFile("gone.json5", null);
    index.applyFile("nightly.json5", null);
    expect(store.has("report")).toBe(false);
    expect(store.has("own")).toBe(true);
  });

  test("a duplicate from a full scan takes over when the original is deleted", () => {
    index.replaceAll([
      { file: "a.json5", definition: def("x", "first") },
      { file: "b.json5", definition: def("x", "second") },
    ]);
    index.applyFile("a.json5", null);
    expect(promptOf("x")).toBe("second");
    expect(index.loadErrors()).toEqual([]);
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

describe("load errors", () => {
  const broken = (file: string, name?: string) => ({
    file,
    ...(name ? { name } : {}),
    error: "/edges: Expected array",
  });

  test("replaceAll keeps the errors of the scan and reports duplicate names", () => {
    index.replaceAll(
      [
        { file: "a.json5", definition: def("x") },
        { file: "b.json5", definition: def("x") },
      ],
      [broken("c.json5", "c")],
    );
    expect(index.loadErrors()).toEqual([
      { file: "b.json5", name: "x", error: 'Duplicate workflow name "x" (already defined in a.json5)' },
      broken("c.json5", "c"),
    ]);
  });

  test("a file that breaks records which workflow it unloaded", () => {
    index.applyFile("nightly.json5", null, broken("nightly.json5", "report"));
    expect(store.has("report")).toBe(false);
    expect(index.loadErrors()).toEqual([{ ...broken("nightly.json5", "report"), unloaded: "report" }]);
  });

  test("fixing, deleting, or disabling the file clears its error", () => {
    index.applyFile("new.json5", null, broken("new.json5", "fresh"));
    index.applyFile("new.json5", def("fresh"));
    expect(index.loadErrors()).toEqual([]);

    index.applyFile("new.json5", null, broken("new.json5", "fresh"));
    index.applyFile("new.json5", null);
    expect(index.loadErrors()).toEqual([]);
  });

  test("a single-file duplicate is reported, and unloads the file's previous workflow", () => {
    index.applyFile("other.json5", def("report"));
    expect(index.loadErrors()).toEqual([
      {
        file: "other.json5",
        name: "report",
        error: 'Duplicate workflow name "report" (already defined in nightly.json5)',
        unloaded: "other",
      },
    ]);
  });

  test("loadErrorFor matches the name in the file, the unloaded workflow, or an unreadable file's name", () => {
    index.applyFile("nightly.json5", null, broken("nightly.json5", "renamed"));
    index.applyFile("x.json5", null, broken("x.json5"));
    index.applyFile("y.json5", null, broken("y.json5", "named-y"));
    expect(index.loadErrorFor("renamed")?.file).toBe("nightly.json5");
    expect(index.loadErrorFor("report")?.file).toBe("nightly.json5");
    expect(index.loadErrorFor("x")?.file).toBe("x.json5");
    // A file that has a readable name is not matched by its file name.
    expect(index.loadErrorFor("y")).toBeUndefined();
    expect(index.loadErrorFor("unknown")).toBeUndefined();
  });

  test("missingWorkflowMessage names the broken file, or says not found", () => {
    expect(missingWorkflowMessage("nope", undefined)).toBe("Workflow not found: nope");
    expect(missingWorkflowMessage("report", broken("nightly.json5", "report"))).toBe(
      'Workflow "report" is not loaded because nightly.json5 is invalid: /edges: Expected array',
    );
  });
});
