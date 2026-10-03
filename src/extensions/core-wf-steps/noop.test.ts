import { describe, expect, test } from "bun:test";
import type { StepExecutionContext } from "@ext/types";
import { InMemoryFs } from "just-bash";
import { createNoopHandler } from "./noop";

/** Creates a minimal fake StepExecutionContext for testing. */
function createFakeContext(overrides?: Partial<StepExecutionContext>): StepExecutionContext {
  return {
    resolveTemplate: async (template: string) => ({ resolved: template, warnings: [] }),
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as StepExecutionContext["log"],
    workDir: "/tmp/test-work",
    fs: new InMemoryFs(),
    jobLog: async () => {},
    workflowRunId: "test-run-123",
    ...overrides,
  };
}

describe("createNoopHandler", () => {
  const handler = createNoopHandler();

  describe("metadata", () => {
    test("has correct label and icon", () => {
      expect(handler.label).toBe("End Branch");
      expect(handler.icon).toBe("FlagCheckeredIcon");
    });

    test("is terminal", () => {
      expect(handler.terminal).toBe(true);
    });
  });

  describe("outputSchema", () => {
    test("declares no properties", () => {
      expect(handler.outputSchema).toBeDefined();
      const properties = (handler.outputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(Object.keys(properties).length).toBe(0);
    });
  });

  describe("execute", () => {
    test("resolves to an empty result", async () => {
      const ctx = createFakeContext();
      const stepDef = { slug: "done", type: "noop" };

      await expect(handler.execute(stepDef, ctx)).resolves.toEqual({});
    });

    test("logs that the branch ended", async () => {
      const logged: string[] = [];
      const ctx = createFakeContext({
        jobLog: async (msg: string) => {
          logged.push(msg);
        },
      });
      const stepDef = { slug: "done", type: "noop" };

      await handler.execute(stepDef, ctx);
      expect(logged).toContain("No-op step: branch ended");
    });

    test("strips slug, type, and outputSchema before validation", async () => {
      const ctx = createFakeContext();
      const stepDef = { slug: "done", type: "noop", outputSchema: { type: "string" } };

      await expect(handler.execute(stepDef, ctx)).resolves.toEqual({});
    });
  });
});
