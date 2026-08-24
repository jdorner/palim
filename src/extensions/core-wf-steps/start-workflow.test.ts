import { describe, expect, test } from "bun:test";
import type { StepExecutionContext, StepInputValidation, StepTypeHandler, WorkflowDispatchResult } from "@ext/types";
import {
  createStartWorkflowHandler,
  type StartWorkflowResult,
  WORKFLOW_NAMES_PROVIDER,
  type WorkflowDispatchFn,
} from "./start-workflow";

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

/** Records the arguments a dispatch fn was called with, returning a fixed run id. */
function createRecordingDispatch(runId = "run-abc"): {
  dispatch: WorkflowDispatchFn;
  calls: { name: string; payload: unknown }[];
} {
  const calls: { name: string; payload: unknown }[] = [];
  const dispatch: WorkflowDispatchFn = async (name, payload): Promise<WorkflowDispatchResult> => {
    calls.push({ name, payload });
    return { workflowRunId: runId, jobIds: ["job-1"] };
  };
  return { dispatch, calls };
}

/**
 * Builds a handler with a recording dispatch and a fixed list of known
 * workflow names (for validateInput coverage).
 */
function makeHandler(runId = "run-abc", knownNames: string[] = []) {
  const { dispatch, calls } = createRecordingDispatch(runId);
  const handler = createStartWorkflowHandler(dispatch, () => knownNames);
  return { handler, calls };
}

describe("createStartWorkflowHandler", () => {
  describe("metadata", () => {
    test("has correct label and icon", () => {
      const { handler } = makeHandler();
      expect(handler.label).toBe("Start Workflow");
      expect(handler.icon).toBe("FlowArrowIcon");
    });

    test("schema requires workflowName and allows optional payload", () => {
      const { handler } = makeHandler();
      expect(handler.schema.properties.workflowName).toBeDefined();
      expect(handler.schema.properties.payload).toBeDefined();
      expect(handler.schema.required).toContain("workflowName");
      expect(handler.schema.required ?? []).not.toContain("payload");
    });

    test("workflowName declares the workflow-names dynamic item provider", () => {
      const { handler } = makeHandler();
      const workflowNameProp = handler.schema.properties.workflowName as { dynamicItems?: string };
      expect(workflowNameProp.dynamicItems).toBe(WORKFLOW_NAMES_PROVIDER);
    });

    test("is not a terminal step", () => {
      const { handler } = makeHandler();
      expect(handler.terminal).toBeUndefined();
    });

    test("outputSchema declares started, workflowName, and workflowRunId", () => {
      const { handler } = makeHandler();
      const properties = (handler.outputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(properties.started).toBeDefined();
      expect(properties.workflowName).toBeDefined();
      expect(properties.workflowRunId).toBeDefined();
    });
  });

  describe("execute", () => {
    test("dispatches the named workflow and returns run info", async () => {
      const { handler, calls } = makeHandler("run-xyz");
      const ctx = createFakeContext();
      const stepDef = { slug: "start", type: "start-workflow", workflowName: "cleanup" };

      const result = await handler.execute(stepDef, ctx);

      expect(calls).toHaveLength(1);
      expect(calls[0]!.name).toBe("cleanup");
      expect(result).toEqual({ started: true, workflowName: "cleanup", workflowRunId: "run-xyz" });
    });

    test("dispatches with undefined payload when none is configured", async () => {
      const { handler, calls } = makeHandler();
      const ctx = createFakeContext();
      const stepDef = { slug: "start", type: "start-workflow", workflowName: "cleanup" };

      await handler.execute(stepDef, ctx);

      expect(calls[0]!.payload).toBeUndefined();
    });

    test("parses a JSON payload into a structured object", async () => {
      const { handler, calls } = makeHandler();
      const ctx = createFakeContext();
      const stepDef = {
        slug: "start",
        type: "start-workflow",
        workflowName: "process",
        payload: '{"id": 42, "name": "widget"}',
      };

      await handler.execute(stepDef, ctx);

      expect(calls[0]!.payload).toEqual({ id: 42, name: "widget" });
    });

    test("forwards a non-JSON payload as a raw string", async () => {
      const { handler, calls } = makeHandler();
      const ctx = createFakeContext();
      const stepDef = {
        slug: "start",
        type: "start-workflow",
        workflowName: "process",
        payload: "just some text",
      };

      await handler.execute(stepDef, ctx);

      expect(calls[0]!.payload).toBe("just some text");
    });

    test("resolves templates in workflowName and payload", async () => {
      const { handler, calls } = makeHandler();
      const ctx = createFakeContext({
        resolveTemplate: async (template: string) => {
          if (template === "{{trigger.target}}") {
            return { resolved: "downstream", warnings: [] };
          }
          if (template === "{{steps.build.result}}") {
            return { resolved: '{"ok": true}', warnings: [] };
          }
          return { resolved: template, warnings: [] };
        },
      });
      const stepDef = {
        slug: "start",
        type: "start-workflow",
        workflowName: "{{trigger.target}}",
        payload: "{{steps.build.result}}",
      };

      const result = (await handler.execute(stepDef, ctx)) as StartWorkflowResult;

      expect(calls[0]!.name).toBe("downstream");
      expect(calls[0]!.payload).toEqual({ ok: true });
      expect(result.workflowName).toBe("downstream");
    });

    test("trims whitespace from the resolved workflow name", async () => {
      const { handler, calls } = makeHandler();
      const ctx = createFakeContext({
        resolveTemplate: async () => ({ resolved: "  spaced  ", warnings: [] }),
      });
      const stepDef = { slug: "start", type: "start-workflow", workflowName: "{{x}}" };

      await handler.execute(stepDef, ctx);

      expect(calls[0]!.name).toBe("spaced");
    });

    test("throws when the resolved workflow name is empty", async () => {
      const { handler } = makeHandler();
      const ctx = createFakeContext({
        resolveTemplate: async () => ({ resolved: "   ", warnings: [] }),
      });
      const stepDef = { slug: "start", type: "start-workflow", workflowName: "{{missing}}" };

      await expect(handler.execute(stepDef, ctx)).rejects.toThrow("resolved workflow name is empty");
    });

    test("throws on invalid configuration (missing workflowName)", async () => {
      const { handler } = makeHandler();
      const ctx = createFakeContext();
      const stepDef = { slug: "start", type: "start-workflow" };

      await expect(handler.execute(stepDef, ctx)).rejects.toThrow("Invalid start-workflow step configuration");
    });

    test("throws on invalid configuration (unknown property)", async () => {
      const { handler } = makeHandler();
      const ctx = createFakeContext();
      const stepDef = { slug: "start", type: "start-workflow", workflowName: "ok", unexpected: "nope" };

      await expect(handler.execute(stepDef, ctx)).rejects.toThrow("Invalid start-workflow step configuration");
    });

    test("propagates dispatch errors (e.g. workflow not found)", async () => {
      const dispatch: WorkflowDispatchFn = async () => {
        throw new Error("Workflow not found: ghost");
      };
      const handler = createStartWorkflowHandler(dispatch, () => []);
      const ctx = createFakeContext();
      const stepDef = { slug: "start", type: "start-workflow", workflowName: "ghost" };

      await expect(handler.execute(stepDef, ctx)).rejects.toThrow("Workflow not found: ghost");
    });

    test("strips slug, type, and outputSchema before validation", async () => {
      const { handler, calls } = makeHandler();
      const ctx = createFakeContext();
      const stepDef = {
        slug: "start",
        type: "start-workflow",
        outputSchema: { type: "object" },
        workflowName: "cleanup",
      };

      await handler.execute(stepDef, ctx);

      expect(calls).toHaveLength(1);
    });
  });

  describe("validateInput", () => {
    /** Invokes validateInput and normalizes the sync-or-async result. */
    async function validate(handler: StepTypeHandler, stepDef: Record<string, unknown>): Promise<StepInputValidation> {
      return handler.validateInput!(null, stepDef);
    }

    test("accepts a static workflow name that exists", async () => {
      const { handler } = makeHandler("run-abc", ["cleanup", "process"]);
      const result = await validate(handler, { slug: "start", type: "start-workflow", workflowName: "cleanup" });
      expect(result).toEqual({ valid: true });
    });

    test("rejects a static workflow name that does not exist", async () => {
      const { handler } = makeHandler("run-abc", ["cleanup", "process"]);
      const result = await validate(handler, { slug: "start", type: "start-workflow", workflowName: "ghost" });
      expect(result.valid).toBe(false);
      expect(result.diagnostics?.[0]).toContain('unknown workflow "ghost"');
    });

    test("diagnostics list the available workflow names", async () => {
      const { handler } = makeHandler("run-abc", ["beta", "alpha"]);
      const result = await validate(handler, { slug: "start", type: "start-workflow", workflowName: "ghost" });
      // Names are sorted for stable, readable diagnostics.
      expect(result.diagnostics?.[0]).toContain("alpha, beta");
    });

    test("reports (none loaded) when no workflows are known", async () => {
      const { handler } = makeHandler("run-abc", []);
      const result = await validate(handler, { slug: "start", type: "start-workflow", workflowName: "ghost" });
      expect(result.valid).toBe(false);
      expect(result.diagnostics?.[0]).toContain("(none loaded)");
    });

    test("skips validation for templated workflow names", async () => {
      const { handler } = makeHandler("run-abc", ["cleanup"]);
      const result = await validate(handler, {
        slug: "start",
        type: "start-workflow",
        workflowName: "{{trigger.target}}",
      });
      expect(result).toEqual({ valid: true });
    });

    test("trims the configured name before checking existence", async () => {
      const { handler } = makeHandler("run-abc", ["cleanup"]);
      const result = await validate(handler, { slug: "start", type: "start-workflow", workflowName: "  cleanup  " });
      expect(result).toEqual({ valid: true });
    });

    test("defers empty/missing name to the execute-time schema check", async () => {
      const { handler } = makeHandler("run-abc", ["cleanup"]);
      expect(await validate(handler, { slug: "start", type: "start-workflow", workflowName: "" })).toEqual({
        valid: true,
      });
      expect(await validate(handler, { slug: "start", type: "start-workflow" })).toEqual({ valid: true });
    });
  });
});
