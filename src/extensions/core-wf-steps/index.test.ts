import { describe, expect, test } from "bun:test";
import type { ExtensionContext, StepTypeHandler } from "@ext/types";
import extension from "./index";

describe("core-wf-steps extension", () => {
  test("registers every step type with its stepDocs Markdown", async () => {
    const registered = new Map<string, StepTypeHandler>();
    const ctx = {
      stepTypes: { register: (type: string, handler: StepTypeHandler) => registered.set(type, handler) },
      dynamicItems: { register: () => {} },
      workflows: { dispatch: async () => ({ workflowRunId: "r", jobIds: [] }), names: () => [] },
    } as unknown as ExtensionContext;

    await extension.initialize(ctx);

    expect([...registered.keys()].sort()).toEqual([
      "chunk",
      "fail",
      "http-request",
      "noop",
      "set-variables",
      "start-workflow",
    ]);
    for (const handler of registered.values()) {
      expect(handler.docs?.trim()).toBeTruthy();
      expect(typeof handler.execute).toBe("function");
    }
  });
});
