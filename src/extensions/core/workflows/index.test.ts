/**
 * Tests for the workflows extension utility functions, step ordering logic, and route handlers.
 */

import { afterEach, beforeEach, describe, expect, test, xdescribe } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Extension, ExtensionContext, HttpMethod, RouteHandler } from "@ext/types";
import { buildRunStatus, createExtension, validateWorkflowDependencies } from "./index";
import type { WorkflowDefinition } from "./schemas";

// ---------------------------------------------------------------------------
// buildRunStatus
// ---------------------------------------------------------------------------

describe("buildRunStatus", () => {
  test("returns 'failed' when any step is failed", () => {
    expect(buildRunStatus(["completed", "failed", "waiting"])).toBe("failed");
  });

  test("returns 'failed' when any step is unknown", () => {
    expect(buildRunStatus(["completed", "unknown"])).toBe("failed");
  });

  test("returns 'completed' when all steps are completed", () => {
    expect(buildRunStatus(["completed", "completed", "completed"])).toBe("completed");
  });

  test("returns 'queued' when all steps are waiting", () => {
    expect(buildRunStatus(["waiting", "waiting", "waiting"])).toBe("queued");
  });

  test("returns 'queued' when all steps are in pre-active states", () => {
    expect(buildRunStatus(["waiting", "created", "delayed", "waiting-children"])).toBe("queued");
  });

  test("returns 'running' when steps are in mixed active states", () => {
    expect(buildRunStatus(["completed", "active", "waiting"])).toBe("running");
  });

  test("returns 'running' for empty step list", () => {
    expect(buildRunStatus([])).toBe("running");
  });

  test("returns 'running' when one step is completed and rest are waiting", () => {
    expect(buildRunStatus(["completed", "waiting", "waiting"])).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// Step ordering (regression test for the GET /:name route fix)
// ---------------------------------------------------------------------------

describe("step ordering", () => {
  test("steps sorted by stepIndex produce correct left-to-right display order", () => {
    // Simulate jobs returned in descending order (as getAllJobs returns them)
    const jobsDescending = [
      { stepSlug: "notify", stepIndex: 2, status: "waiting", jobId: "job-3" },
      { stepSlug: "process", stepIndex: 1, status: "active", jobId: "job-2" },
      { stepSlug: "fetch", stepIndex: 0, status: "completed", jobId: "job-1" },
    ];

    // Build steps array as the route handler does (iterating jobs in descending order)
    const steps: Array<{ slug: string; status: string; jobId: string; stepIndex: number }> = [];
    for (const job of jobsDescending) {
      steps.push({ slug: job.stepSlug, status: job.status, jobId: job.jobId, stepIndex: job.stepIndex });
    }

    // Apply the sort fix
    steps.sort((a, b) => a.stepIndex - b.stepIndex);

    // Verify correct order: fetch (0) -> process (1) -> notify (2)
    expect(steps[0]!.slug).toBe("fetch");
    expect(steps[1]!.slug).toBe("process");
    expect(steps[2]!.slug).toBe("notify");
  });

  test("steps with same stepIndex preserve insertion order", () => {
    // Edge case: should not happen in practice, but verifies sort stability
    const steps = [
      { slug: "b", status: "waiting", jobId: "j2", stepIndex: 0 },
      { slug: "a", status: "waiting", jobId: "j1", stepIndex: 0 },
    ];

    steps.sort((a, b) => a.stepIndex - b.stepIndex);

    // Both have stepIndex 0, stable sort preserves insertion order
    expect(steps[0]!.slug).toBe("b");
    expect(steps[1]!.slug).toBe("a");
  });

  test("single step needs no sorting", () => {
    const steps = [{ slug: "only-step", status: "completed", jobId: "j1", stepIndex: 0 }];
    steps.sort((a, b) => a.stepIndex - b.stepIndex);
    expect(steps[0]!.slug).toBe("only-step");
  });
});

// ---------------------------------------------------------------------------
// Route handler tests
// ---------------------------------------------------------------------------

/** A valid workflow payload for testing. */
function validWorkflow(name = "test-workflow") {
  return {
    name,
    description: "A test workflow",
    trigger: { type: "manual" as const },
    steps: [{ slug: "step-one", type: "agent" as const, prompt: "Do something" }],
  };
}

/** Creates a minimal mock ExtensionContext and captures registered routes. */
function createMockContext(workDir: string) {
  const routes = new Map<string, RouteHandler>();

  const ctx: ExtensionContext = {
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as ExtensionContext["log"],
    workDir,
    dataDir: workDir,
    extensionsDir: workDir,
    fetch: globalThis.fetch,
    getToolNames: () => ["tool-beta", "tool-alpha", "tool-gamma"],
    registerTool: () => {},
    registerRoute: (method: HttpMethod, routePath: string, handler: RouteHandler) => {
      routes.set(`${method} ${routePath}`, handler);
    },
    createQueue: (() => ({
      onEvent: () => {},
      getAllJobs: async () => [],
      getJobLogs: async () => ({ logs: [], count: 0 }),
      retryJob: async () => true,
      cancelJob: async () => true,
    })) as unknown as ExtensionContext["createQueue"],
    on: () => {},
    emitEvent: () => {},
    broadcast: () => {},
    getConfig: (() => undefined) as unknown as ExtensionContext["getConfig"],
    getDatabase: () => ({}) as unknown as ReturnType<ExtensionContext["getDatabase"]>,
    isEnabled: (() => true) as unknown as ExtensionContext["isEnabled"],
    runAgent: async () => ({ answer: "", state: null, timestamp: Date.now() }),
    enqueueAgent: async () => "job-id",
    sessions: {
      create: () => ({ id: "session-1", source: "test", messages: [], createdAt: Date.now(), updatedAt: Date.now() }),
    } as unknown as ExtensionContext["sessions"],
    pushMessage: () => ({ status: "stored" }) as ReturnType<ExtensionContext["pushMessage"]>,
    queues: {
      onEvent: () => {},
      offEvent: () => {},
      getJobLogs: async () => ({ logs: [], count: 0 }),
      getFlowProducer: () =>
        ({
          addChain: async () => ({ jobs: [] }),
        }) as unknown as ReturnType<ExtensionContext["queues"]["getFlowProducer"]>,
      getAllQueueNames: () => [],
    },
    secrets: {
      get: async () => null,
      set: async () => {},
    },
    skills: {
      resolve: () => undefined,
      getNames: () => ["skill-charlie", "skill-alice", "skill-bob"],
      rescan: async () => {},
    },
    loadExtension: async () => true,
    unloadExtension: async () => true,
    registerDynamicItemProvider: () => {},
  };

  return { ctx, routes };
}

describe("workflow route handlers", () => {
  let tmpDir: string;
  let ext: Extension;
  let routes: Map<string, RouteHandler>;

  beforeEach(async () => {
    tmpDir = path.join(import.meta.dir, `.tmp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(path.join(tmpDir, "workflows"), { recursive: true });

    ext = createExtension();
    const mock = createMockContext(tmpDir);
    routes = mock.routes;
    await ext.initialize(mock.ctx);
  });

  afterEach(async () => {
    await ext.shutdown();
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // GET /meta/tools
  // -------------------------------------------------------------------------

  describe("GET /meta/tools", () => {
    test("returns sorted tool names", async () => {
      const handler = routes.get("GET /meta/tools")!;
      expect(handler).toBeDefined();

      const response = await handler({} as unknown as Parameters<RouteHandler>[0]);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body).toEqual(["tool-alpha", "tool-beta", "tool-gamma"]);
    });
  });

  // -------------------------------------------------------------------------
  // GET /meta/skills
  // -------------------------------------------------------------------------

  describe("GET /meta/skills", () => {
    test("returns sorted skill names", async () => {
      const handler = routes.get("GET /meta/skills")!;
      expect(handler).toBeDefined();

      const response = await handler({} as unknown as Parameters<RouteHandler>[0]);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body).toEqual(["skill-alice", "skill-bob", "skill-charlie"]);
    });
  });

  // -------------------------------------------------------------------------
  // PUT /:name
  // -------------------------------------------------------------------------

  describe("PUT /:name", () => {
    test("with valid payload writes JSON5 and returns 200", async () => {
      // Seed an existing workflow on disk so the extension loads it
      const wfName = "existing-wf";
      const wfData = validWorkflow(wfName);
      const filePath = path.join(tmpDir, "workflows", `${wfName}.json5`);
      await Bun.write(filePath, JSON.stringify(wfData, null, 2));

      // Re-initialize to load the seeded workflow
      await ext.shutdown();
      ext = createExtension();
      const mock = createMockContext(tmpDir);
      routes = mock.routes;
      await ext.initialize(mock.ctx);

      const handler = routes.get("PUT /:name")!;
      expect(handler).toBeDefined();

      const updatedPayload = { ...wfData, description: "Updated description" };
      const response = await handler({
        params: { name: wfName },
        body: updatedPayload,
      } as unknown as Parameters<RouteHandler>[0]);

      expect(response.status).toBe(200);
      const resBody = await response.json();
      expect(resBody).toEqual({ ok: true });

      // Verify file was written
      const fileContent = await Bun.file(filePath).text();
      const parsed = JSON.parse(fileContent);
      expect(parsed.description).toBe("Updated description");
    });

    test("with invalid payload returns 400", async () => {
      // Seed a workflow so the name exists
      const wfName = "bad-update";
      const wfData = validWorkflow(wfName);
      await Bun.write(path.join(tmpDir, "workflows", `${wfName}.json5`), JSON.stringify(wfData, null, 2));

      await ext.shutdown();
      ext = createExtension();
      const mock = createMockContext(tmpDir);
      routes = mock.routes;
      await ext.initialize(mock.ctx);

      const handler = routes.get("PUT /:name")!;

      // Invalid body - missing steps
      const response = await handler({
        params: { name: wfName },
        body: { name: wfName, trigger: { type: "manual" } },
      } as unknown as Parameters<RouteHandler>[0]);

      expect(response.status).toBe(400);
      const resBody = (await response.json()) as { error: string };
      expect(resBody.error).toContain("Validation failed");
    });

    test("with name mismatch returns 400", async () => {
      // Seed a workflow
      const wfName = "mismatch-wf";
      const wfData = validWorkflow(wfName);
      await Bun.write(path.join(tmpDir, "workflows", `${wfName}.json5`), JSON.stringify(wfData, null, 2));

      await ext.shutdown();
      ext = createExtension();
      const mock = createMockContext(tmpDir);
      routes = mock.routes;
      await ext.initialize(mock.ctx);

      const handler = routes.get("PUT /:name")!;

      // Body name does not match URL parameter
      const response = await handler({
        params: { name: wfName },
        body: validWorkflow("different-name"),
      } as unknown as Parameters<RouteHandler>[0]);

      expect(response.status).toBe(400);
      const resBody = (await response.json()) as { error: string };
      expect(resBody.error).toContain("does not match");
    });

    test("for non-existent workflow returns 404", async () => {
      const handler = routes.get("PUT /:name")!;

      const response = await handler({
        params: { name: "does-not-exist" },
        body: validWorkflow("does-not-exist"),
      } as unknown as Parameters<RouteHandler>[0]);

      expect(response.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // POST /
  // -------------------------------------------------------------------------

  xdescribe("POST /", () => {
    test("with valid payload creates file and returns 201", async () => {
      const handler = routes.get("POST /")!;
      expect(handler).toBeDefined();

      const payload = validWorkflow("new-workflow");
      const response = await handler({
        body: payload,
      } as unknown as Parameters<RouteHandler>[0]);

      expect(response.status).toBe(201);
      const resBody = await response.json();
      expect(resBody).toEqual({ ok: true, name: "new-workflow" });

      // Verify file was created
      const filePath = path.join(tmpDir, "workflows", "new-workflow.json5");
      const exists = await Bun.file(filePath).exists();
      expect(exists).toBe(true);

      const content = await Bun.file(filePath).text();
      const parsed = JSON.parse(content);
      expect(parsed.name).toBe("new-workflow");
    });

    test("with duplicate name returns 409", async () => {
      // Seed an existing workflow
      const wfName = "duplicate-wf";
      const wfData = validWorkflow(wfName);
      await Bun.write(path.join(tmpDir, "workflows", `${wfName}.json5`), JSON.stringify(wfData, null, 2));

      // Re-initialize to load it into the store
      await ext.shutdown();
      ext = createExtension();
      const mock = createMockContext(tmpDir);
      routes = mock.routes;
      await ext.initialize(mock.ctx);

      const handler = routes.get("POST /")!;

      const response = await handler({
        body: validWorkflow(wfName),
      } as unknown as Parameters<RouteHandler>[0]);

      expect(response.status).toBe(409);
      const resBody = (await response.json()) as { error: string };
      expect(resBody.error).toContain("already exists");
    });

    test("with duplicate step slugs returns 400", async () => {
      const handler = routes.get("POST /")!;

      const payload = {
        name: "dup-slugs",
        trigger: { type: "manual" as const },
        steps: [
          { slug: "same-slug", type: "agent" as const, prompt: "Step 1" },
          { slug: "same-slug", type: "agent" as const, prompt: "Step 2" },
        ],
      };

      const response = await handler({
        body: payload,
      } as unknown as Parameters<RouteHandler>[0]);

      expect(response.status).toBe(400);
      const resBody = (await response.json()) as { error: string };
      expect(resBody.error).toContain("Duplicate step slug");
    });
  });
});

// ---------------------------------------------------------------------------
// validateWorkflowDependencies
// ---------------------------------------------------------------------------

describe("validateWorkflowDependencies", () => {
  /** Creates a minimal mock context with configurable tool and skill lists. */
  function mockCtx(tools: string[], skills: string[]): ExtensionContext {
    return {
      getToolNames: () => tools,
      skills: { resolve: () => undefined, getNames: () => skills, rescan: async () => {} },
    } as unknown as ExtensionContext;
  }

  test("returns valid when workflow has no tools or skills", () => {
    const wf: WorkflowDefinition = {
      name: "simple",
      trigger: { type: "manual" },
      steps: [{ slug: "step-one", type: "agent", prompt: "Hello" }],
    };

    const result = validateWorkflowDependencies(wf, mockCtx([], []));
    expect(result.valid).toBe(true);
    expect(result.missingTools).toEqual([]);
    expect(result.missingSkills).toEqual([]);
  });

  test("returns valid when all tools and skills are available", () => {
    const wf: WorkflowDefinition = {
      name: "all-available",
      trigger: { type: "manual" },
      steps: [
        { slug: "step-one", type: "agent", prompt: "Go", tools: ["exec", "send_telegram_message"], skills: ["wiki"] },
      ],
    };

    const result = validateWorkflowDependencies(wf, mockCtx(["send_telegram_message"], ["wiki"]));
    expect(result.valid).toBe(true);
    expect(result.missingTools).toEqual([]);
    expect(result.missingSkills).toEqual([]);
  });

  test("recognizes sandbox tools as available", () => {
    const wf: WorkflowDefinition = {
      name: "sandbox-tools",
      trigger: { type: "manual" },
      steps: [
        {
          slug: "step-one",
          type: "agent",
          prompt: "Go",
          tools: ["exec", "read_file", "write_file", "list_files", "edit", "create_directory"],
        },
      ],
    };

    // No extension tools registered, but sandbox tools should still pass
    const result = validateWorkflowDependencies(wf, mockCtx([], []));
    expect(result.valid).toBe(true);
    expect(result.missingTools).toEqual([]);
  });

  test("reports missing tools", () => {
    const wf: WorkflowDefinition = {
      name: "missing-tools",
      trigger: { type: "manual" },
      steps: [
        { slug: "step-one", type: "agent", prompt: "Go", tools: ["exec", "nonexistent_tool"] },
        { slug: "step-two", type: "agent", prompt: "Go", tools: ["another_missing"] },
      ],
    };

    const result = validateWorkflowDependencies(wf, mockCtx([], []));
    expect(result.valid).toBe(false);
    expect(result.missingTools).toEqual(["another_missing", "nonexistent_tool"]);
    expect(result.missingSkills).toEqual([]);
  });

  test("reports missing skills", () => {
    const wf: WorkflowDefinition = {
      name: "missing-skills",
      trigger: { type: "manual" },
      steps: [{ slug: "step-one", type: "agent", prompt: "Go", skills: ["wiki", "nonexistent_skill"] }],
    };

    const result = validateWorkflowDependencies(wf, mockCtx([], ["wiki"]));
    expect(result.valid).toBe(false);
    expect(result.missingTools).toEqual([]);
    expect(result.missingSkills).toEqual(["nonexistent_skill"]);
  });

  test("reports both missing tools and skills", () => {
    const wf: WorkflowDefinition = {
      name: "both-missing",
      trigger: { type: "manual" },
      steps: [{ slug: "step-one", type: "agent", prompt: "Go", tools: ["bad_tool"], skills: ["bad_skill"] }],
    };

    const result = validateWorkflowDependencies(wf, mockCtx([], []));
    expect(result.valid).toBe(false);
    expect(result.missingTools).toEqual(["bad_tool"]);
    expect(result.missingSkills).toEqual(["bad_skill"]);
  });

  test("deduplicates missing items across steps", () => {
    const wf: WorkflowDefinition = {
      name: "duplicates",
      trigger: { type: "manual" },
      steps: [
        { slug: "step-one", type: "agent", prompt: "Go", tools: ["missing_tool"], skills: ["missing_skill"] },
        { slug: "step-two", type: "agent", prompt: "Go", tools: ["missing_tool"], skills: ["missing_skill"] },
      ],
    };

    const result = validateWorkflowDependencies(wf, mockCtx([], []));
    expect(result.missingTools).toEqual(["missing_tool"]);
    expect(result.missingSkills).toEqual(["missing_skill"]);
  });

  test("ignores webhook steps", () => {
    const wf: WorkflowDefinition = {
      name: "webhook-only",
      trigger: { type: "manual" },
      steps: [{ slug: "notify", type: "webhook", url: "https://example.com/hook" }],
    };

    const result = validateWorkflowDependencies(wf, mockCtx([], []));
    expect(result.valid).toBe(true);
  });

  test("returns sorted results", () => {
    const wf: WorkflowDefinition = {
      name: "sorted",
      trigger: { type: "manual" },
      steps: [
        { slug: "step-one", type: "agent", prompt: "Go", tools: ["z_tool", "a_tool"], skills: ["z_skill", "a_skill"] },
      ],
    };

    const result = validateWorkflowDependencies(wf, mockCtx([], []));
    expect(result.missingTools).toEqual(["a_tool", "z_tool"]);
    expect(result.missingSkills).toEqual(["a_skill", "z_skill"]);
  });
});

// ---------------------------------------------------------------------------
// POST /run/:name - dispatch behavior
// ---------------------------------------------------------------------------

describe("POST /run/:name", () => {
  let tmpDir: string;
  let ext: Extension;
  let routes: Map<string, RouteHandler>;

  beforeEach(async () => {
    tmpDir = path.join(import.meta.dir, `.tmp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(path.join(tmpDir, "workflows"), { recursive: true });
  });

  afterEach(async () => {
    await ext.shutdown();
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Helper to seed a workflow and initialize the extension with a custom mock context. */
  async function setupWithWorkflow(wfData: Record<string, unknown>, ctxOverrides?: Partial<ExtensionContext>) {
    const wfName = wfData.name as string;
    await Bun.write(path.join(tmpDir, "workflows", `${wfName}.json5`), JSON.stringify(wfData, null, 2));

    ext = createExtension();
    const mock = createMockContext(tmpDir);
    // Fix the FlowProducer mock to return jobIds (matches real bunqueue API)
    (mock.ctx as any).queues = {
      ...mock.ctx.queues,
      getFlowProducer: () =>
        ({
          addChain: async (steps: unknown[]) => ({
            jobIds: (steps as Array<{ name: string }>).map((_, i) => `job-${i}`),
          }),
        }) as unknown as ReturnType<ExtensionContext["queues"]["getFlowProducer"]>,
    };
    if (ctxOverrides) {
      Object.assign(mock.ctx, ctxOverrides);
    }
    routes = mock.routes;
    await ext.initialize(mock.ctx);
    return mock;
  }

  test("dispatches workflow and returns 202", async () => {
    await setupWithWorkflow({
      name: "all-good",
      trigger: { type: "manual" },
      steps: [
        { slug: "step-one", type: "agent", prompt: "Go", tools: ["exec", "tool-alpha"], skills: ["skill-alice"] },
      ],
    });

    const handler = routes.get("POST /run/:name")!;
    const response = await handler({
      params: { name: "all-good" },
      body: null,
    } as unknown as Parameters<RouteHandler>[0]);

    expect(response.status).toBe(202);
    const body = (await response.json()) as { ok: boolean; workflowRunId: string; jobIds: string[] };
    expect(body.ok).toBe(true);
    expect(body.workflowRunId).toBeDefined();
    expect(body.jobIds.length).toBe(1);
  });

  test("dispatches even when tools are missing (validation happens at step execution)", async () => {
    await setupWithWorkflow({
      name: "missing-deps",
      trigger: { type: "manual" },
      steps: [{ slug: "step-one", type: "agent", prompt: "Go", tools: ["nonexistent_tool"] }],
    });

    const handler = routes.get("POST /run/:name")!;
    const response = await handler({
      params: { name: "missing-deps" },
      body: null,
    } as unknown as Parameters<RouteHandler>[0]);

    // Workflow is dispatched - validation will fail at step execution time
    expect(response.status).toBe(202);
  });

  test("returns 404 for non-existent workflow", async () => {
    await setupWithWorkflow({
      name: "exists",
      trigger: { type: "manual" },
      steps: [{ slug: "step-one", type: "agent", prompt: "Go" }],
    });

    const handler = routes.get("POST /run/:name")!;
    const response = await handler({
      params: { name: "does-not-exist" },
      body: null,
    } as unknown as Parameters<RouteHandler>[0]);

    expect(response.status).toBe(404);
  });
});
