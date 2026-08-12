/**
 * Integration tests for the ctx.workflows.dispatch late-bound dispatch mechanism.
 */

import { describe, expect, test } from "bun:test";
import type { WorkflowDispatchResult } from "@ext/types";
import { EventBus } from "./eventBus";
import { createExtensionContext, setWorkflowDispatchFn } from "./extensionContext";

/** Creates minimal deps for createExtensionContext (only what workflows.dispatch needs). */
function createMinimalDeps() {
  return {
    extensionName: "test-extension",
    workDir: "/tmp/test-work",
    dataDir: "/tmp/test-data",
    extensionsDir: "/tmp/test-extensions",
    toolNameSet: new Set<string>(),
    routeKeySet: new Set<string>(),
    stepTypeNameSet: new Set<string>(),
    eventBus: new EventBus(),
    flowProducer: { addChain: async () => ({ jobs: [] }) } as any,
    runAgentFn: async () => ({ answer: "", state: null, timestamp: Date.now() }),
    database: {} as any,
    sessionStore: {
      create: () => ({ id: "s-1", source: "test", messages: [], createdAt: Date.now(), updatedAt: Date.now() }),
    } as any,
    isExtensionEnabledFn: () => true,
  };
}

describe("ctx.workflows.dispatch", () => {
  describe("late-binding behavior", () => {
    test("throws when dispatch function has not been set", async () => {
      // Reset the module-level dispatch function by setting it to cause the "not initialized" error
      // We simulate the pre-initialization state by creating a fresh context without setting the fn
      // Note: since the module-level state is shared, we need to explicitly unset it
      setWorkflowDispatchFn(null as any);

      const deps = createMinimalDeps();
      const { context } = createExtensionContext(deps);

      expect(context.workflows.dispatch("any-workflow")).rejects.toThrow("Workflows extension not initialized");
    });

    test("succeeds after dispatch function is set", async () => {
      const mockResult: WorkflowDispatchResult = {
        workflowRunId: "run-123",
        jobIds: ["job-1", "job-2"],
      };

      setWorkflowDispatchFn(async (_name, _payload) => mockResult);

      const deps = createMinimalDeps();
      const { context } = createExtensionContext(deps);

      const result = await context.workflows.dispatch("test-workflow", { key: "value" });
      expect(result).toEqual(mockResult);
    });
  });

  describe("dispatch error handling", () => {
    test("throws when workflow is not found", async () => {
      setWorkflowDispatchFn(async (name) => {
        throw new Error(`Workflow not found: ${name}`);
      });

      const deps = createMinimalDeps();
      const { context } = createExtensionContext(deps);

      expect(context.workflows.dispatch("nonexistent")).rejects.toThrow("Workflow not found: nonexistent");
    });

    test("throws when workflow is disabled", async () => {
      setWorkflowDispatchFn(async (name) => {
        throw new Error(`Workflow is disabled: ${name}`);
      });

      const deps = createMinimalDeps();
      const { context } = createExtensionContext(deps);

      expect(context.workflows.dispatch("my-workflow")).rejects.toThrow("Workflow is disabled: my-workflow");
    });
  });

  describe("dispatch passes arguments correctly", () => {
    test("passes name and payload to the dispatch function", async () => {
      let capturedName: string | undefined;
      let capturedPayload: unknown;

      setWorkflowDispatchFn(async (name, payload) => {
        capturedName = name;
        capturedPayload = payload;
        return { workflowRunId: "run-1", jobIds: [] };
      });

      const deps = createMinimalDeps();
      const { context } = createExtensionContext(deps);

      await context.workflows.dispatch("invoice-process", { filePath: "inbox/test.pdf" });

      expect(capturedName).toBe("invoice-process");
      expect(capturedPayload).toEqual({ filePath: "inbox/test.pdf" });
    });

    test("payload defaults to undefined when not provided", async () => {
      let capturedPayload: unknown = "sentinel";

      setWorkflowDispatchFn(async (_name, payload) => {
        capturedPayload = payload;
        return { workflowRunId: "run-1", jobIds: [] };
      });

      const deps = createMinimalDeps();
      const { context } = createExtensionContext(deps);

      await context.workflows.dispatch("simple-workflow");

      expect(capturedPayload).toBeUndefined();
    });
  });
});
