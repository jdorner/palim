/**
 * Tests for the Workflow Engine's `dispatchWorkflow` and `buildFlowSteps` functions.
 *
 * Validates that:
 * - Single-segment workflows with only non-CF steps dispatch all steps via addChain
 * - Workflows whose only segment is a CF node (e.g. `if` as the first/only step)
 *   return empty jobIds so the caller can invoke the segment dispatcher
 * - Multi-segment workflows dispatch only the first (non-CF) segment
 * - buildFlowSteps produces correct FlowStep data structures
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import type { FlowProducer, FlowStep } from "bunqueue/client";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { buildFlowSteps, dispatchWorkflow, type SessionFactory } from "./engine";
import * as runStore from "./runStore";
import type { WorkflowDefinition } from "./schemas";
import type { WorkflowStepJobData } from "./types";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const MIGRATION_SQL = `
CREATE TABLE \`workflow_runs\` (
  \`id\` text PRIMARY KEY NOT NULL,
  \`workflow_name\` text NOT NULL,
  \`status\` text NOT NULL DEFAULT 'running',
  \`step_results\` text NOT NULL DEFAULT '{}',
  \`trigger_payload\` text,
  \`current_step_index\` integer NOT NULL DEFAULT 0,
  \`full_step_order\` text NOT NULL,
  \`failure_reason\` text,
  \`created_at\` integer NOT NULL,
  \`updated_at\` integer NOT NULL
);
CREATE INDEX \`idx_workflow_runs_name\` ON \`workflow_runs\` (\`workflow_name\`);
CREATE INDEX \`idx_workflow_runs_status\` ON \`workflow_runs\` (\`status\`);
`;

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run(MIGRATION_SQL);
  const db = drizzle(sqlite);
  runStore.initRunStore(db);
  return db;
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function createFakeFlowProducer() {
  const chains: FlowStep<WorkflowStepJobData>[][] = [];
  return {
    chains,
    addChain: async (steps: FlowStep<WorkflowStepJobData>[]) => {
      chains.push(steps);
      return { jobIds: steps.map((_, i) => `job-${i}`) };
    },
  };
}

function createFakeSessionFactory(): SessionFactory {
  let counter = 0;
  return {
    create: () => ({ id: `session-${++counter}` }),
  };
}

function createFakeLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dispatchWorkflow", () => {
  beforeEach(() => {
    createTestDb();
  });

  test("dispatches all steps as a single chain for sequential-only workflows", async () => {
    const definition: WorkflowDefinition = {
      name: "simple-workflow",
      trigger: { type: "manual" },
      enabled: true,
      steps: [
        { slug: "step-a", type: "agent", prompt: "do A" },
        { slug: "step-b", type: "agent", prompt: "do B" },
      ],
    };

    const flow = createFakeFlowProducer();
    const log = createFakeLogger();
    const sessionFactory = createFakeSessionFactory();

    const result = await dispatchWorkflow(
      flow as unknown as FlowProducer,
      definition,
      null,
      log as unknown as Parameters<typeof dispatchWorkflow>[3],
      sessionFactory,
    );

    // Should dispatch one chain with both steps
    expect(flow.chains).toHaveLength(1);
    expect(flow.chains[0]).toHaveLength(2);
    expect(flow.chains[0]![0]!.data.stepSlug).toBe("step-a");
    expect(flow.chains[0]![1]!.data.stepSlug).toBe("step-b");
    expect(result.jobIds).toHaveLength(2);
  });

  test("returns empty jobIds when the only step is a control flow node", async () => {
    const definition: WorkflowDefinition = {
      name: "cf-only-workflow",
      trigger: { type: "manual" },
      enabled: true,
      steps: [
        {
          slug: "check-priority",
          type: "if",
          condition: {
            ref: "{{trigger.payload.priority}}",
            eq: "high",
          },
          // biome-ignore lint/suspicious/noThenProperty: "then" is the workflow branch keyword
          then: [{ slug: "handle-high", type: "agent", prompt: "handle high priority" }],
          else: [{ slug: "handle-low", type: "agent", prompt: "handle low priority" }],
        },
      ],
    };

    const flow = createFakeFlowProducer();
    const log = createFakeLogger();
    const sessionFactory = createFakeSessionFactory();

    const result = await dispatchWorkflow(
      flow as unknown as FlowProducer,
      definition,
      { priority: "high" },
      log as unknown as Parameters<typeof dispatchWorkflow>[3],
      sessionFactory,
    );

    // The if-node should NOT be dispatched as a queue job.
    // The engine returns empty jobIds so the caller can invoke
    // the segment dispatcher at index 0.
    expect(flow.chains).toHaveLength(0);
    expect(result.jobIds).toHaveLength(0);
    expect(result.workflowRunId).not.toBe("");

    // A run store record should still be created
    const run = runStore.get(result.workflowRunId);
    expect(run).not.toBeNull();
    expect(run!.status).toBe("running");
    expect(run!.workflowName).toBe("cf-only-workflow");
  });

  test("returns empty jobIds when the first step is a CF node in a multi-step workflow", async () => {
    const definition: WorkflowDefinition = {
      name: "cf-first-workflow",
      trigger: { type: "manual" },
      enabled: true,
      steps: [
        {
          slug: "check",
          type: "if",
          condition: { ref: "{{trigger.payload.go}}", eq: "yes" },
          // biome-ignore lint/suspicious/noThenProperty: "then" is the workflow branch keyword
          then: [{ slug: "branch-yes", type: "agent", prompt: "yes" }],
          else: [{ slug: "branch-no", type: "agent", prompt: "no" }],
        },
        { slug: "step-after", type: "agent", prompt: "after" },
      ],
    };

    const flow = createFakeFlowProducer();
    const log = createFakeLogger();
    const sessionFactory = createFakeSessionFactory();

    const result = await dispatchWorkflow(
      flow as unknown as FlowProducer,
      definition,
      { go: "yes" },
      log as unknown as Parameters<typeof dispatchWorkflow>[3],
      sessionFactory,
    );

    // The first segment is the CF node - nothing dispatched to queue
    expect(flow.chains).toHaveLength(0);
    expect(result.jobIds).toHaveLength(0);
  });

  test("dispatches first non-CF segment only for multi-segment workflows", async () => {
    const definition: WorkflowDefinition = {
      name: "multi-segment-workflow",
      trigger: { type: "manual" },
      enabled: true,
      steps: [
        { slug: "step-a", type: "agent", prompt: "do A" },
        {
          slug: "check",
          type: "if",
          condition: { ref: "{{steps.step-a.result}}", eq: "go" },
          // biome-ignore lint/suspicious/noThenProperty: "then" is the workflow branch keyword
          then: [{ slug: "handle-go", type: "agent", prompt: "go" }],
          else: [{ slug: "handle-stop", type: "agent", prompt: "stop" }],
        },
        { slug: "step-c", type: "agent", prompt: "do C" },
      ],
    };

    const flow = createFakeFlowProducer();
    const log = createFakeLogger();
    const sessionFactory = createFakeSessionFactory();

    const result = await dispatchWorkflow(
      flow as unknown as FlowProducer,
      definition,
      null,
      log as unknown as Parameters<typeof dispatchWorkflow>[3],
      sessionFactory,
    );

    // Should only dispatch the first segment (step-a), not the if-node or step-c
    expect(flow.chains).toHaveLength(1);
    expect(flow.chains[0]).toHaveLength(1);
    expect(flow.chains[0]![0]!.data.stepSlug).toBe("step-a");
    expect(result.jobIds).toHaveLength(1);
  });

  test("creates a run store record even when no jobs are dispatched", async () => {
    const definition: WorkflowDefinition = {
      name: "cf-workflow",
      trigger: { type: "manual" },
      enabled: true,
      steps: [
        {
          slug: "branch",
          type: "case",
          match: "{{trigger.payload.env}}",
          paths: {
            prod: [{ slug: "deploy-prod", type: "agent", prompt: "deploy to prod" }],
            dev: [{ slug: "deploy-dev", type: "agent", prompt: "deploy to dev" }],
          },
        },
      ],
    };

    const flow = createFakeFlowProducer();
    const log = createFakeLogger();
    const sessionFactory = createFakeSessionFactory();

    const result = await dispatchWorkflow(
      flow as unknown as FlowProducer,
      definition,
      { env: "prod" },
      log as unknown as Parameters<typeof dispatchWorkflow>[3],
      sessionFactory,
    );

    // No jobs dispatched (CF-only first segment)
    expect(result.jobIds).toHaveLength(0);

    // Run store record exists
    const run = runStore.get(result.workflowRunId);
    expect(run).not.toBeNull();
    expect(run!.workflowName).toBe("cf-workflow");
    expect(run!.triggerPayload).toEqual({ env: "prod" });
    expect(run!.fullStepOrder).toEqual(["branch"]);
  });

  test("injects trigger payload into the first step's job data", async () => {
    const definition: WorkflowDefinition = {
      name: "payload-workflow",
      trigger: { type: "manual" },
      enabled: true,
      steps: [{ slug: "step-a", type: "agent", prompt: "do A" }],
    };

    const flow = createFakeFlowProducer();
    const log = createFakeLogger();
    const sessionFactory = createFakeSessionFactory();

    await dispatchWorkflow(
      flow as unknown as FlowProducer,
      definition,
      { key: "value" },
      log as unknown as Parameters<typeof dispatchWorkflow>[3],
      sessionFactory,
    );

    expect(flow.chains[0]![0]!.data.triggerPayload).toEqual({ key: "value" });
  });
});

describe("buildFlowSteps", () => {
  test("creates FlowStep array with correct queue name and job data", () => {
    const steps = [
      { slug: "step-a", type: "agent", prompt: "do A" },
      { slug: "step-b", type: "agent", prompt: "do B" },
    ];

    const result = buildFlowSteps(steps, {
      workflowRunId: "run-1",
      workflowName: "test-workflow",
      totalSteps: 2,
      globalIndexOffset: 0,
      allStepDefs: { "step-a": steps[0], "step-b": steps[1] },
      fullStepOrder: ["step-a", "step-b"],
      sessionFactory: createFakeSessionFactory(),
      triggerPayload: { foo: "bar" },
    });

    expect(result).toHaveLength(2);
    expect(result[0]!.queueName).toBe("workflows:steps");
    expect(result[0]!.data.stepSlug).toBe("step-a");
    expect(result[0]!.data.workflowRunId).toBe("run-1");
    expect(result[0]!.data.workflowName).toBe("test-workflow");
    expect(result[0]!.data.stepIndex).toBe(0);
    expect(result[0]!.data.totalSteps).toBe(2);
    // Trigger payload injected into first step
    expect(result[0]!.data.triggerPayload).toEqual({ foo: "bar" });
    // Second step does not get trigger payload directly
    expect(result[1]!.data.triggerPayload).toBeUndefined();
  });

  test("injects accumulated step results into the first step of non-first segments", () => {
    const steps = [{ slug: "step-b", type: "agent", prompt: "do B" }];

    const result = buildFlowSteps(steps, {
      workflowRunId: "run-1",
      workflowName: "test-workflow",
      totalSteps: 3,
      globalIndexOffset: 2,
      allStepDefs: { "step-b": steps[0] },
      fullStepOrder: ["step-a", "check", "step-b"],
      sessionFactory: createFakeSessionFactory(),
      accumulatedStepResults: { "step-a": "result-a", check: { condition: true, chosenBranch: "then" } },
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.data.accumulatedStepResults).toEqual({
      "step-a": "result-a",
      check: { condition: true, chosenBranch: "then" },
    });
  });

  test("applies globalIndexOffset to step indices", () => {
    const steps = [
      { slug: "step-c", type: "agent", prompt: "do C" },
      { slug: "step-d", type: "agent", prompt: "do D" },
    ];

    const result = buildFlowSteps(steps, {
      workflowRunId: "run-1",
      workflowName: "test-workflow",
      totalSteps: 4,
      globalIndexOffset: 2,
      allStepDefs: { "step-c": steps[0], "step-d": steps[1] },
      fullStepOrder: ["step-a", "step-b", "step-c", "step-d"],
      sessionFactory: createFakeSessionFactory(),
    });

    expect(result[0]!.data.stepIndex).toBe(2);
    expect(result[1]!.data.stepIndex).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Integration test: segment dispatcher + bunqueue reserved key validation
// ---------------------------------------------------------------------------

/**
 * Simulates bunqueue's reserved key validation: any data key starting with
 * "__" is rejected. This is the actual check in bunqueue/dist/client/flowPlan.js.
 */
function createStrictFlowProducer() {
  const chains: FlowStep<WorkflowStepJobData>[][] = [];
  return {
    chains,
    addChain: async (steps: FlowStep<WorkflowStepJobData>[]) => {
      // Replicate bunqueue's reserved key validation
      for (const node of steps) {
        if (typeof node.data === "object" && node.data !== null) {
          for (const key of Object.keys(node.data)) {
            if (key.startsWith("__")) {
              throw new Error(`flow job data key is reserved: ${key}`);
            }
          }
        }
      }
      chains.push(steps);
      return { jobIds: steps.map((_, i) => `job-${i}`) };
    },
  };
}

describe("segment dispatcher branch dispatch with bunqueue validation", () => {
  // Lazily import to keep the top-level imports minimal
  let dispatchNextSegment: typeof import("./segmentDispatcher").dispatchNextSegment;
  let signalStore: typeof import("./signalStore");

  const SIGNAL_MIGRATION_SQL = `
CREATE TABLE \`workflow_signals\` (
  \`id\` text PRIMARY KEY NOT NULL,
  \`run_id\` text NOT NULL,
  \`step_slug\` text NOT NULL,
  \`event\` text NOT NULL,
  \`status\` text NOT NULL DEFAULT 'waiting',
  \`input_schema\` text,
  \`timeout_ms\` integer,
  \`payload\` text,
  \`created_at\` integer NOT NULL,
  \`received_at\` integer
);
CREATE INDEX \`idx_workflow_signals_run_event\` ON \`workflow_signals\` (\`run_id\`, \`event\`);
CREATE INDEX \`idx_workflow_signals_status\` ON \`workflow_signals\` (\`status\`);
`;

  const MIGRATION_SQL_FULL = `
CREATE TABLE \`workflow_runs\` (
  \`id\` text PRIMARY KEY NOT NULL,
  \`workflow_name\` text NOT NULL,
  \`status\` text NOT NULL DEFAULT 'running',
  \`step_results\` text NOT NULL DEFAULT '{}',
  \`trigger_payload\` text,
  \`current_step_index\` integer NOT NULL DEFAULT 0,
  \`full_step_order\` text NOT NULL,
  \`failure_reason\` text,
  \`created_at\` integer NOT NULL,
  \`updated_at\` integer NOT NULL
);
CREATE INDEX \`idx_workflow_runs_name\` ON \`workflow_runs\` (\`workflow_name\`);
CREATE INDEX \`idx_workflow_runs_status\` ON \`workflow_runs\` (\`status\`);
${SIGNAL_MIGRATION_SQL}
`;

  beforeEach(async () => {
    const mod = await import("./segmentDispatcher");
    dispatchNextSegment = mod.dispatchNextSegment;
    signalStore = await import("./signalStore");

    const sqlite = new Database(":memory:");
    sqlite.run("PRAGMA journal_mode = WAL");
    sqlite.run(MIGRATION_SQL_FULL);
    const db = drizzle(sqlite);
    runStore.initRunStore(db);
    signalStore.initSignalStore(db);
  });

  test("if-node branch dispatch succeeds with bunqueue reserved key validation", async () => {
    // Previously this test reproduced a runtime error where __isBranchStep
    // was rejected by bunqueue. After renaming to isBranchStep (no __ prefix),
    // the branch dispatch should succeed.

    const thenStep = { slug: "handle-else", type: "agent", prompt: "handle else" };
    const ifNode = {
      slug: "check-priority",
      type: "if" as const,
      condition: {
        ref: "{{steps.cf-test.result}}",
        eq: "some other text",
      },
      // biome-ignore lint/suspicious/noThenProperty: "then" is the workflow branch keyword
      then: [{ slug: "test-then", type: "agent", prompt: "hey" }],
      else: [thenStep],
    };

    const steps = [ifNode];

    // Create a run in the store - the condition will evaluate to false
    // (ref is unresolvable), so the else branch should be dispatched.
    const runId = "run-cf-test";
    runStore.create({
      id: runId,
      workflowName: "cf-test",
      status: "running",
      stepResults: {},
      triggerPayload: null,
      currentStepIndex: 0,
      fullStepOrder: ["check-priority"],
      failureReason: null,
    });

    const flow = createStrictFlowProducer();
    const events: unknown[] = [];

    const deps = {
      steps,
      allStepDefs: { "check-priority": ifNode } as Record<string, unknown>,
      flowProducer: flow as unknown as FlowProducer,
      sessionFactory: createFakeSessionFactory(),
      log: createFakeLogger() as unknown as Parameters<typeof dispatchNextSegment>[2]["log"],
      broadcast: (event: unknown) => {
        events.push(event);
      },
    };

    // With the fix, branch dispatch should succeed (no reserved key error)
    await dispatchNextSegment(runId, 0, deps);

    // The else branch should have been dispatched successfully
    expect(flow.chains).toHaveLength(1);
    expect(flow.chains[0]).toHaveLength(1);
    expect(flow.chains[0]![0]!.data.stepSlug).toBe("handle-else");
    expect(flow.chains[0]![0]!.data.isBranchStep).toBe(true);

    // The run should NOT be failed
    const run = runStore.get(runId);
    expect(run!.status).not.toBe("failed");
  });
});
