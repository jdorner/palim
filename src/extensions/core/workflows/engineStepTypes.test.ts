import { describe, expect, test } from "bun:test";
import { listEngineStepTypes, readStepDocs } from "./engineStepTypes";
import { DagStepDefSchema } from "./schemas";

describe("listEngineStepTypes", () => {
  test("lists every engine step type with non-empty docs", async () => {
    const types = await listEngineStepTypes({ hitl: true });

    expect(types.map((t) => t.type)).toEqual(["agent", "if", "case", "iterator", "aggregator", "waitFor", "humanTask"]);
    for (const t of types) {
      expect(t.extensionName).toBe("workflows");
      expect(t.description).toBeTruthy();
      expect(t.docs?.trim()).toBeTruthy();
    }
  });

  test("covers every literal step type of the definition schema except emit (a registered handler)", async () => {
    const variants = DagStepDefSchema.anyOf as Array<{ properties?: { type?: { const?: unknown } } }>;
    const schemaTypes = variants
      .map((s) => s.properties?.type?.const)
      .filter((t): t is string => typeof t === "string" && t !== "emit");
    const listed = (await listEngineStepTypes({ hitl: true })).map((t) => t.type);

    expect([...listed].sort()).toEqual([...schemaTypes].sort());
  });

  test("omits humanTask when human tasks are disabled", async () => {
    const types = await listEngineStepTypes({ hitl: false });

    expect(types.map((t) => t.type)).not.toContain("humanTask");
  });
});

describe("readStepDocs", () => {
  test("reads the docs of the registered emit handler", async () => {
    expect(await readStepDocs("emit")).toContain("targetRun");
  });
});
