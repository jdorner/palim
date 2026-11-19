import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Logger } from "@ext/types";
import type { WorkflowLoadError } from "@shared/workflows";
import { loadDagWorkflowFiles, loadSingleWorkflow } from "./dagLoader";

const log = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

const VALID = `{ name: "ok", trigger: { type: "manual" }, steps: { a: { type: "agent", prompt: "hi" } }, edges: [] }`;

let dir: string;
let errors: WorkflowLoadError[];
const sink = (e: WorkflowLoadError) => errors.push(e);

async function load(file: string, content: string) {
  const filePath = path.join(dir, file);
  await Bun.write(filePath, content);
  return loadSingleWorkflow(filePath, log, sink);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "palim-wf-loader-"));
  errors = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadSingleWorkflow load errors", () => {
  test("a valid file reports nothing", async () => {
    expect((await load("ok.json5", VALID))?.name).toBe("ok");
    expect(errors).toEqual([]);
  });

  test("a schema error reports the file, its name, and the reason", async () => {
    expect(await load("no-edges.json5", VALID.replace(", edges: []", ""))).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ file: "no-edges.json5", name: "ok" });
    expect(errors[0]!.error).toContain("/edges");
  });

  test("a graph error reports the reason", async () => {
    const twoLooseSteps = VALID.replace(
      `steps: { a: { type: "agent", prompt: "hi" } }`,
      `steps: { a: { type: "agent", prompt: "hi" }, b: { type: "agent", prompt: "hi" } }`,
    );
    expect(await load("loose.json5", twoLooseSteps)).toBeNull();
    expect(errors[0]).toMatchObject({ file: "loose.json5", name: "ok" });
    expect(errors[0]!.error).toContain('Step "a" is not connected');
  });

  test("an unparsable file reports the parse error without a name", async () => {
    expect(await load("broken.json5", "{{{")).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.file).toBe("broken.json5");
    expect(errors[0]!.name).toBeUndefined();
    expect(errors[0]!.error.length).toBeGreaterThan(0);
  });

  test("a disabled file is skipped without an error", async () => {
    expect(await load("off.json5", VALID.replace("{ name", "{ enabled: false, name"))).toBeNull();
    expect(errors).toEqual([]);
  });
});

describe("loadDagWorkflowFiles load errors", () => {
  test("reports each invalid file of the scan", async () => {
    await Bun.write(path.join(dir, "ok.json5"), VALID);
    await Bun.write(path.join(dir, "broken.json5"), "{{{");
    const loaded = await loadDagWorkflowFiles(dir, log, sink);
    expect(loaded.map((l) => l.file)).toEqual(["ok.json5"]);
    expect(errors.map((e) => e.file)).toEqual(["broken.json5"]);
  });
});
