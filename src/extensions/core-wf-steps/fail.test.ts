import { describe, expect, test } from "bun:test";
import type { StepExecutionContext } from "@ext/types";
import { createFailHandler } from "./fail";

/** Creates a minimal fake StepExecutionContext for testing. */
function createFakeContext(overrides?: Partial<StepExecutionContext>): StepExecutionContext {
  return {
    resolveTemplate: async (template: string) => ({ resolved: template, warnings: [] }),
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as StepExecutionContext["log"],
    workDir: "/tmp/test-work",
    jobLog: async () => {},
    workflowRunId: "test-run-123",
    ...overrides,
  };
}

describe("createFailHandler", () => {
  const handler = createFailHandler();

  describe("metadata", () => {
    test("has correct label and icon", () => {
      expect(handler.label).toBe("Fail");
      expect(handler.icon).toBe("\uD83D\uDCA3");
    });

    test("schema allows optional message field", () => {
      expect(handler.schema.properties.message).toBeDefined();
    });
  });

  describe("execute", () => {
    test("throws with default message when no message is provided", async () => {
      const ctx = createFakeContext();
      const stepDef = { slug: "abort", type: "fail" };

      await expect(handler.execute(stepDef, ctx)).rejects.toThrow("Workflow aborted by fail step");
    });

    test("throws with custom message", async () => {
      const ctx = createFakeContext();
      const stepDef = { slug: "abort", type: "fail", message: "Something went wrong" };

      await expect(handler.execute(stepDef, ctx)).rejects.toThrow("Something went wrong");
    });

    test("resolves template expressions in message", async () => {
      const ctx = createFakeContext({
        resolveTemplate: async (template: string) => ({
          resolved: template.replace("{{steps.check.result}}", "invalid-input"),
          warnings: [],
        }),
      });
      const stepDef = { slug: "abort", type: "fail", message: "Failed: {{steps.check.result}}" };

      await expect(handler.execute(stepDef, ctx)).rejects.toThrow("Failed: invalid-input");
    });

    test("logs template resolution warnings", async () => {
      const logged: string[] = [];
      const ctx = createFakeContext({
        resolveTemplate: async (template: string) => ({
          resolved: template,
          warnings: ["unresolved variable: steps.missing.result"],
        }),
        jobLog: async (msg: string) => {
          logged.push(msg);
        },
      });
      const stepDef = { slug: "abort", type: "fail", message: "oops" };

      await expect(handler.execute(stepDef, ctx)).rejects.toThrow("oops");
      expect(logged).toContain("Warning (message): unresolved variable: steps.missing.result");
    });

    test("logs the fail trigger message before throwing", async () => {
      const logged: string[] = [];
      const ctx = createFakeContext({
        jobLog: async (msg: string) => {
          logged.push(msg);
        },
      });
      const stepDef = { slug: "abort", type: "fail", message: "halted" };

      await expect(handler.execute(stepDef, ctx)).rejects.toThrow("halted");
      expect(logged).toContain("Fail step triggered: halted");
    });

    test("throws on invalid configuration (message is not a string)", async () => {
      const ctx = createFakeContext();
      const stepDef = { slug: "abort", type: "fail", message: 123 };

      await expect(handler.execute(stepDef, ctx)).rejects.toThrow("Invalid fail step configuration");
    });

    test("strips slug, type, and outputSchema before validation", async () => {
      const ctx = createFakeContext();
      const stepDef = { slug: "abort", type: "fail", outputSchema: { type: "string" } };

      // Should not throw validation error for these internal fields
      await expect(handler.execute(stepDef, ctx)).rejects.toThrow("Workflow aborted by fail step");
    });
  });
});
