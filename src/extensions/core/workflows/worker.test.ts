/**
 * Tests for the workflow step worker's custom step type dispatch.
 */

import { describe, expect, test } from "bun:test";
import type { StepExecutionContext, StepTypeHandler } from "@ext/types";
import { Type } from "@sinclair/typebox";
import type { WorkflowStepJobData } from "./types";
import type { StepWorkerDeps } from "./worker";
import { createStepProcessor } from "./worker";

/** Minimal mock job for testing. */
function createMockJob(stepDef: Record<string, unknown>, overrides: Partial<WorkflowStepJobData> = {}) {
  const logs: string[] = [];
  const data: WorkflowStepJobData = {
    workflowRunId: "run-1",
    workflowName: "test-workflow",
    stepSlug: "test-step",
    stepIndex: 0,
    totalSteps: 1,
    stepDef: stepDef as any,
    sessionId: "session-1",
    ...overrides,
  };

  return {
    id: "job-1",
    data,
    log: async (msg: string) => {
      logs.push(msg);
    },
    logs,
  };
}

/** Creates minimal StepWorkerDeps for testing custom step dispatch. */
function createMockDeps(getStepHandler?: (type: string) => StepTypeHandler | undefined): StepWorkerDeps {
  return {
    ctx: {
      workDir: "/tmp/test-work",
      skills: { resolve: () => undefined, getNames: () => [], rescan: async () => {} },
      getToolNames: () => [],
      sessions: { append: () => {} },
      runAgent: async () => ({ answer: "test", state: null, timestamp: Date.now() }),
      secrets: { get: async () => null, set: async () => {} },
    } as any,
    flowProducer: {
      getParentResult: () => undefined,
    } as any,
    emitEvent: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    getStepHandler,
  };
}

describe("createStepProcessor - custom step types", () => {
  test("dispatches to custom handler when step type matches", async () => {
    let receivedStepDef: Record<string, unknown> | null = null;
    let receivedCtx: StepExecutionContext | null = null;

    const handler: StepTypeHandler = {
      schema: Type.Object({ path: Type.String() }),
      label: "Test Handler",
      execute: async (stepDef, ctx) => {
        receivedStepDef = stepDef;
        receivedCtx = ctx;
        return { filePath: "/tmp/output.xlsx", rowCount: 5 };
      },
    };

    const deps = createMockDeps((type) => (type === "excel" ? handler : undefined));
    const processor = createStepProcessor(deps);

    const job = createMockJob({
      slug: "test-step",
      type: "excel",
      mode: "create",
      path: "data/reports",
    });

    const result = await processor(job as any);

    expect(receivedStepDef).not.toBeNull();
    expect(receivedStepDef!.type).toBe("excel");
    expect(receivedStepDef!.mode).toBe("create");
    expect(receivedCtx).not.toBeNull();
    expect(receivedCtx!.workDir).toBe("/tmp/test-work");
    expect(result.value).toEqual({ filePath: "/tmp/output.xlsx", rowCount: 5 });
  });

  test("throws for unknown step type with no handler", async () => {
    const deps = createMockDeps(() => undefined);
    const processor = createStepProcessor(deps);

    const job = createMockJob({ slug: "bad-step", type: "nonexistent" });

    await expect(processor(job as any)).rejects.toThrow('Step type "nonexistent" is not available');
    expect(job.logs).toContain(
      'Step type "nonexistent" is not available. The extension providing this step type may be disabled or not installed.',
    );
  });

  test("throws for unknown step type when getStepHandler is not provided", async () => {
    const deps = createMockDeps(undefined);
    const processor = createStepProcessor(deps);

    const job = createMockJob({ slug: "bad-step", type: "nonexistent" });

    await expect(processor(job as any)).rejects.toThrow('Step type "nonexistent" is not available');
  });

  test("custom handler errors are propagated and logged", async () => {
    const handler: StepTypeHandler = {
      schema: Type.Object({}),
      label: "Failing Handler",
      execute: async () => {
        throw new Error("Handler execution failed: disk full");
      },
    };

    const deps = createMockDeps((type) => (type === "fail" ? handler : undefined));
    const processor = createStepProcessor(deps);

    const job = createMockJob({ slug: "fail-step", type: "fail" });

    await expect(processor(job as any)).rejects.toThrow("Handler execution failed: disk full");
    expect(job.logs).toContain("Error: Handler execution failed: disk full");
  });

  test("custom handler receives template resolution via StepExecutionContext", async () => {
    let resolvedValue = "";

    const handler: StepTypeHandler = {
      schema: Type.Object({}),
      label: "Template Handler",
      execute: async (_stepDef, ctx) => {
        const { resolved } = await ctx.resolveTemplate("hello {{env.OPENAI_API_KEY}}");
        resolvedValue = resolved;
        return { resolved: resolvedValue };
      },
    };

    const deps = createMockDeps((type) => (type === "tmpl" ? handler : undefined));
    const processor = createStepProcessor(deps);

    const job = createMockJob({ slug: "tmpl-step", type: "tmpl" });

    await processor(job as any);

    // OPENAI_API_KEY is not in the workflow env allowlist, so it should remain unresolved
    expect(resolvedValue).toBe("hello {{env.OPENAI_API_KEY}}");
  });

  test("custom handler can use jobLog to write to job logs", async () => {
    const handler: StepTypeHandler = {
      schema: Type.Object({}),
      label: "Logging Handler",
      execute: async (_stepDef, ctx) => {
        await ctx.jobLog("Processing started");
        await ctx.jobLog("Processing completed");
        return { done: true };
      },
    };

    const deps = createMockDeps((type) => (type === "log" ? handler : undefined));
    const processor = createStepProcessor(deps);

    const job = createMockJob({ slug: "log-step", type: "log" });

    await processor(job as any);

    expect(job.logs).toContain("Processing started");
    expect(job.logs).toContain("Processing completed");
  });

  test("step result is accumulated with previous step results", async () => {
    const handler: StepTypeHandler = {
      schema: Type.Object({}),
      label: "Accumulator",
      execute: async () => ({ output: "step-2-result" }),
    };

    const deps = createMockDeps((type) => (type === "custom" ? handler : undefined));
    // Simulate a parent that already has step results
    deps.flowProducer = {
      getParentResult: () => ({
        value: "step-1-value",
        _stepResults: { "step-1": "step-1-value" },
        _triggerPayload: { file: "test.pdf" },
      }),
    } as any;

    const processor = createStepProcessor(deps);

    const job = createMockJob(
      { slug: "step-2", type: "custom" },
      { stepSlug: "step-2", stepIndex: 1, totalSteps: 2, __flowParentId: "parent-job-1" },
    );

    const result = await processor(job as any);

    expect(result.value).toEqual({ output: "step-2-result" });
    expect(result._stepResults).toEqual({
      "step-1": "step-1-value",
      "step-2": { output: "step-2-result" },
    });
    expect(result._triggerPayload).toEqual({ file: "test.pdf" });
  });
});
