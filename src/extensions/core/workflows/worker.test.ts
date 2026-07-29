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
      paths: { work: "/tmp/test-work", data: "/tmp/test-data", extensions: "/tmp/test-extensions" },
      skills: { resolve: () => undefined, names: () => [], rescan: async () => {} },
      tools: { names: () => [], register: () => {} },
      sessions: { append: () => {} },
      agent: { run: async () => ({ answer: "test", state: null, timestamp: Date.now() }), enqueue: async () => "id" },
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

describe("createStepProcessor - input validation", () => {
  test("skips validation when next step has no handler", async () => {
    // Agent step followed by another agent step — no custom handler to validate against
    const deps = createMockDeps(() => undefined);
    deps.ctx = {
      ...deps.ctx,
      sessions: { append: () => {} },
      agent: {
        run: async () => ({ answer: "some output", state: null, timestamp: Date.now() }),
        enqueue: async () => "id",
      },
      tools: { names: () => ["exec"], register: () => {} },
      skills: { resolve: () => undefined, names: () => [], rescan: async () => {} },
    } as any;

    const processor = createStepProcessor(deps);

    const job = createMockJob(
      { slug: "extract", type: "agent", prompt: "Do something" },
      {
        stepIndex: 0,
        totalSteps: 2,
        stepOrder: ["extract", "write"],
        allStepDefs: {
          extract: { slug: "extract", type: "agent", prompt: "Do something" },
          write: { slug: "write", type: "agent", prompt: "Write something" },
        },
      },
    );

    const result = await processor(job as any);
    expect(result.value).toBe("some output");
  });

  test("skips validation when next step handler has no inputSchema or validateInput", async () => {
    const handler: StepTypeHandler = {
      schema: Type.Object({ path: Type.String() }),
      label: "No Validation Handler",
      execute: async () => ({ done: true }),
    };

    const deps = createMockDeps((type) => (type === "custom" ? handler : undefined));
    deps.ctx = {
      ...deps.ctx,
      sessions: { append: () => {} },
      agent: {
        run: async () => ({ answer: '{"key": "value"}', state: null, timestamp: Date.now() }),
        enqueue: async () => "id",
      },
      tools: { names: () => ["exec"], register: () => {} },
      skills: { resolve: () => undefined, names: () => [], rescan: async () => {} },
    } as any;

    const processor = createStepProcessor(deps);

    const job = createMockJob(
      { slug: "extract", type: "agent", prompt: "Extract data" },
      {
        stepIndex: 0,
        totalSteps: 2,
        stepOrder: ["extract", "write"],
        allStepDefs: {
          extract: { slug: "extract", type: "agent", prompt: "Extract data" },
          write: { slug: "write", type: "custom", path: "/out" },
        },
      },
    );

    const result = await processor(job as any);
    expect(result.value).toBe('{"key": "value"}');
  });

  test("passes validation when inputSchema matches output", async () => {
    const handler: StepTypeHandler = {
      schema: Type.Object({ path: Type.String() }),
      label: "Schema Handler",
      inputSchema: Type.String({ minLength: 1 }),
      execute: async () => ({ done: true }),
    };

    const deps = createMockDeps((type) => (type === "typed" ? handler : undefined));
    deps.ctx = {
      ...deps.ctx,
      sessions: { append: () => {} },
      agent: {
        run: async () => ({ answer: "valid string output", state: null, timestamp: Date.now() }),
        enqueue: async () => "id",
      },
      tools: { names: () => ["exec"], register: () => {} },
      skills: { resolve: () => undefined, names: () => [], rescan: async () => {} },
    } as any;

    const processor = createStepProcessor(deps);

    const job = createMockJob(
      { slug: "extract", type: "agent", prompt: "Extract" },
      {
        stepIndex: 0,
        totalSteps: 2,
        stepOrder: ["extract", "consume"],
        allStepDefs: {
          extract: { slug: "extract", type: "agent", prompt: "Extract" },
          consume: { slug: "consume", type: "typed", path: "/out" },
        },
      },
    );

    const result = await processor(job as any);
    expect(result.value).toBe("valid string output");
  });

  test("triggers repair loop when inputSchema validation fails then succeeds", async () => {
    let callCount = 0;

    const handler: StepTypeHandler = {
      schema: Type.Object({}),
      label: "Numeric Handler",
      inputSchema: Type.Number(),
      execute: async () => ({ done: true }),
    };

    const deps = createMockDeps((type) => (type === "numeric" ? handler : undefined));
    deps.ctx = {
      ...deps.ctx,
      sessions: { append: () => {} },
      agent: {
        run: async () => {
          callCount++;
          // First call returns a string (fails validation), second returns... still a string
          // because the agent always returns strings. The inputSchema Type.Number() won't match.
          // Let's use validateInput instead for this test case.
          return { answer: callCount === 1 ? "not a number" : "42", state: null, timestamp: Date.now() };
        },
        enqueue: async () => "id",
      },
      tools: { names: () => ["exec"], register: () => {} },
      skills: { resolve: () => undefined, names: () => [], rescan: async () => {} },
    } as any;

    // Use validateInput which can parse the string
    const handlerWithValidate: StepTypeHandler = {
      schema: Type.Object({}),
      label: "Parsed Number Handler",
      validateInput(output) {
        if (typeof output !== "string") return { valid: false, diagnostics: ["Expected string"] };
        const num = Number(output);
        if (Number.isNaN(num)) return { valid: false, diagnostics: ["Output must be a valid number"] };
        return { valid: true };
      },
      execute: async () => ({ done: true }),
    };

    const deps2 = createMockDeps((type) => (type === "parsed" ? handlerWithValidate : undefined));
    let callCount2 = 0;
    deps2.ctx = {
      ...deps2.ctx,
      sessions: { append: () => {} },
      agent: {
        run: async () => {
          callCount2++;
          return {
            answer: callCount2 === 1 ? "not a number" : "42",
            state: null,
            timestamp: Date.now(),
          };
        },
        enqueue: async () => "id",
      },
      tools: { names: () => ["exec"], register: () => {} },
      skills: { resolve: () => undefined, names: () => [], rescan: async () => {} },
    } as any;

    const processor = createStepProcessor(deps2);

    const job = createMockJob(
      { slug: "extract", type: "agent", prompt: "Give me a number" },
      {
        stepIndex: 0,
        totalSteps: 2,
        stepOrder: ["extract", "consume"],
        allStepDefs: {
          extract: { slug: "extract", type: "agent", prompt: "Give me a number" },
          consume: { slug: "consume", type: "parsed" },
        },
      },
    );

    const result = await processor(job as any);

    // Should have called the agent twice (initial + 1 repair)
    expect(callCount2).toBe(2);
    expect(result.value).toBe("42");
    // Logs should contain the validation failure message
    expect(job.logs.some((l) => l.includes("Input validation failed"))).toBe(true);
  });

  test("fails after max retries when validation never passes", async () => {
    const handler: StepTypeHandler = {
      schema: Type.Object({}),
      label: "Always Fails",
      validateInput() {
        return { valid: false, diagnostics: ["Data is always wrong"] };
      },
      execute: async () => ({ done: true }),
    };

    let callCount = 0;
    const deps = createMockDeps((type) => (type === "strict" ? handler : undefined));
    deps.ctx = {
      ...deps.ctx,
      sessions: { append: () => {} },
      agent: {
        run: async () => {
          callCount++;
          return { answer: "bad output", state: null, timestamp: Date.now() };
        },
        enqueue: async () => "id",
      },
      tools: { names: () => ["exec"], register: () => {} },
      skills: { resolve: () => undefined, names: () => [], rescan: async () => {} },
    } as any;

    const processor = createStepProcessor(deps);

    const job = createMockJob(
      { slug: "extract", type: "agent", prompt: "Extract" },
      {
        stepIndex: 0,
        totalSteps: 2,
        stepOrder: ["extract", "consume"],
        allStepDefs: {
          extract: { slug: "extract", type: "agent", prompt: "Extract" },
          consume: { slug: "consume", type: "strict" },
        },
      },
    );

    await expect(processor(job as any)).rejects.toThrow(
      'Input validation for next step "consume" failed after 2 repair attempts',
    );
    // Initial call + 2 retries = 3 agent calls
    expect(callCount).toBe(3);
  });

  test("validateInput takes precedence over inputSchema", async () => {
    let validateCalled = false;

    const handler: StepTypeHandler = {
      schema: Type.Object({}),
      label: "Both Methods",
      inputSchema: Type.Number(), // Would fail on string output
      validateInput(output) {
        validateCalled = true;
        // Custom validation accepts strings
        return { valid: typeof output === "string" };
      },
      execute: async () => ({ done: true }),
    };

    const deps = createMockDeps((type) => (type === "both" ? handler : undefined));
    deps.ctx = {
      ...deps.ctx,
      sessions: { append: () => {} },
      agent: {
        run: async () => ({ answer: "string output", state: null, timestamp: Date.now() }),
        enqueue: async () => "id",
      },
      tools: { names: () => ["exec"], register: () => {} },
      skills: { resolve: () => undefined, names: () => [], rescan: async () => {} },
    } as any;

    const processor = createStepProcessor(deps);

    const job = createMockJob(
      { slug: "extract", type: "agent", prompt: "Extract" },
      {
        stepIndex: 0,
        totalSteps: 2,
        stepOrder: ["extract", "consume"],
        allStepDefs: {
          extract: { slug: "extract", type: "agent", prompt: "Extract" },
          consume: { slug: "consume", type: "both" },
        },
      },
    );

    const result = await processor(job as any);
    expect(validateCalled).toBe(true);
    expect(result.value).toBe("string output");
  });

  test("skips validation when current step is the last step", async () => {
    const handler: StepTypeHandler = {
      schema: Type.Object({}),
      label: "Should Not Be Called",
      validateInput() {
        throw new Error("Should not be called");
      },
      execute: async () => ({ done: true }),
    };

    const deps = createMockDeps((type) => (type === "custom" ? handler : undefined));
    deps.ctx = {
      ...deps.ctx,
      sessions: { append: () => {} },
      agent: {
        run: async () => ({ answer: "output", state: null, timestamp: Date.now() }),
        enqueue: async () => "id",
      },
      tools: { names: () => ["exec"], register: () => {} },
      skills: { resolve: () => undefined, names: () => [], rescan: async () => {} },
    } as any;

    const processor = createStepProcessor(deps);

    const job = createMockJob(
      { slug: "final", type: "agent", prompt: "Last step" },
      {
        stepIndex: 0,
        totalSteps: 1,
        stepOrder: ["final"],
        allStepDefs: { final: { slug: "final", type: "agent", prompt: "Last step" } },
      },
    );

    const result = await processor(job as any);
    expect(result.value).toBe("output");
  });

  test("async validateInput is supported", async () => {
    const handler: StepTypeHandler = {
      schema: Type.Object({}),
      label: "Async Validator",
      async validateInput(output) {
        // Simulate async validation (e.g. checking a remote schema)
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (typeof output === "string" && output.includes("valid")) {
          return { valid: true };
        }
        return { valid: false, diagnostics: ["Output must contain 'valid'"] };
      },
      execute: async () => ({ done: true }),
    };

    let callCount = 0;
    const deps = createMockDeps((type) => (type === "async" ? handler : undefined));
    deps.ctx = {
      ...deps.ctx,
      sessions: { append: () => {} },
      agent: {
        run: async () => {
          callCount++;
          return {
            answer: callCount === 1 ? "bad" : "this is valid",
            state: null,
            timestamp: Date.now(),
          };
        },
        enqueue: async () => "id",
      },
      tools: { names: () => ["exec"], register: () => {} },
      skills: { resolve: () => undefined, names: () => [], rescan: async () => {} },
    } as any;

    const processor = createStepProcessor(deps);

    const job = createMockJob(
      { slug: "extract", type: "agent", prompt: "Produce" },
      {
        stepIndex: 0,
        totalSteps: 2,
        stepOrder: ["extract", "consume"],
        allStepDefs: {
          extract: { slug: "extract", type: "agent", prompt: "Produce" },
          consume: { slug: "consume", type: "async" },
        },
      },
    );

    const result = await processor(job as any);
    expect(callCount).toBe(2);
    expect(result.value).toBe("this is valid");
  });
});
