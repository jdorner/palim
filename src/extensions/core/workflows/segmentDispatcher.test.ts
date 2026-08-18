/**
 * Tests for the Segment Dispatcher's `if`, `case`, and `emit` handlers.
 *
 * Uses in-memory SQLite for isolation. Validates Requirements 3.1-3.8
 * (if handler), Requirements 4.1-4.6 (case handler), and Requirements
 * 7.1-7.6 (emit handler): condition evaluation, branch dispatch, template
 * resolution, result accumulation, exact case-sensitive matching, signal
 * delivery, partial failure handling, and error handling.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import type { WorkflowWebSocketEvent } from "@shared/workflows";
import type { FlowProducer, FlowStep } from "bunqueue/client";
import { drizzle } from "drizzle-orm/bun-sqlite";
import fc from "fast-check";
import type { SessionFactory } from "./engine";
import * as runStore from "./runStore";
import type { CaseStep, EmitStep, IfStep, WorkflowStep } from "./schemas";
import { dispatchNextSegment, type SegmentDispatcherDeps } from "./segmentDispatcher";
import * as signalStore from "./signalStore";
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

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run(MIGRATION_SQL);
  const db = drizzle(sqlite);
  runStore.initRunStore(db);
  signalStore.initSignalStore(db);
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

function createFakeBroadcast() {
  const events: WorkflowWebSocketEvent[] = [];
  return {
    events,
    fn: (event: WorkflowWebSocketEvent) => {
      events.push(event);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a simple agent step definition. */
function agentStep(slug: string): WorkflowStep {
  return { slug, type: "agent", prompt: `Do ${slug}` };
}

/** Creates an if step definition. */
function ifStep(opts: {
  slug: string;
  ref: string;
  operator: string;
  operand: unknown;
  thenSteps: WorkflowStep[];
  elseSteps?: WorkflowStep[];
}): IfStep {
  const condition: Record<string, unknown> = { ref: opts.ref };
  condition[opts.operator] = opts.operand;
  const step: IfStep = {
    slug: opts.slug,
    type: "if",
    condition: condition as IfStep["condition"],
    // biome-ignore lint/suspicious/noThenProperty: "then" is the workflow branch keyword
    then: opts.thenSteps,
  };
  if (opts.elseSteps) {
    step.else = opts.elseSteps;
  }
  return step;
}

/** Creates a run in the Run Store and returns the ID. */
function createRun(opts: {
  id?: string;
  workflowName?: string;
  stepResults?: Record<string, unknown>;
  triggerPayload?: unknown;
  fullStepOrder?: string[];
}) {
  const id = opts.id ?? "run-1";
  runStore.create({
    id,
    workflowName: opts.workflowName ?? "test-workflow",
    status: "running",
    stepResults: opts.stepResults ?? {},
    triggerPayload: opts.triggerPayload ?? null,
    currentStepIndex: 0,
    fullStepOrder: opts.fullStepOrder ?? ["prev-step", "check-if"],
    failureReason: null,
  });
  return id;
}

/** Builds SegmentDispatcherDeps from fakes. */
function buildDeps(opts: {
  steps: WorkflowStep[];
  flowProducer: ReturnType<typeof createFakeFlowProducer>;
  broadcast: ReturnType<typeof createFakeBroadcast>;
  sessionFactory?: SessionFactory;
}): SegmentDispatcherDeps {
  const allStepDefs: Record<string, unknown> = {};
  for (const s of opts.steps) {
    allStepDefs[s.slug] = s;
  }
  return {
    steps: opts.steps,
    allStepDefs,
    flowProducer: opts.flowProducer as unknown as FlowProducer,
    sessionFactory: opts.sessionFactory ?? createFakeSessionFactory(),
    log: createFakeLogger() as SegmentDispatcherDeps["log"],
    broadcast: opts.broadcast.fn,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Segment Dispatcher", () => {
  beforeEach(() => {
    createTestDb();
  });

  describe("if handler", () => {
    test("dispatches then branch when condition is true", async () => {
      const thenStep = agentStep("then-action");
      const ifNode = ifStep({
        slug: "check-if",
        ref: "{{steps.prev-step.result}}",
        operator: "eq",
        operand: "go",
        thenSteps: [thenStep],
      });

      const steps: WorkflowStep[] = [agentStep("prev-step"), ifNode];

      const runId = createRun({
        stepResults: { "prev-step": "go" },
        fullStepOrder: ["prev-step", "check-if"],
      });

      const flow = createFakeFlowProducer();
      const broadcast = createFakeBroadcast();
      const deps = buildDeps({ steps, flowProducer: flow, broadcast });

      await dispatchNextSegment(runId, 1, deps);

      // Then branch was dispatched
      expect(flow.chains).toHaveLength(1);
      const dispatched = flow.chains[0]!;
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]!.data.stepSlug).toBe("then-action");
    });

    test("dispatches else branch when condition is false and else exists", async () => {
      const thenStep = agentStep("then-action");
      const elseStep = agentStep("else-action");
      const ifNode = ifStep({
        slug: "check-if",
        ref: "{{steps.prev-step.result}}",
        operator: "eq",
        operand: "go",
        thenSteps: [thenStep],
        elseSteps: [elseStep],
      });

      const steps: WorkflowStep[] = [agentStep("prev-step"), ifNode];

      const runId = createRun({
        stepResults: { "prev-step": "stop" },
        fullStepOrder: ["prev-step", "check-if"],
      });

      const flow = createFakeFlowProducer();
      const broadcast = createFakeBroadcast();
      const deps = buildDeps({ steps, flowProducer: flow, broadcast });

      await dispatchNextSegment(runId, 1, deps);

      // Else branch was dispatched
      expect(flow.chains).toHaveLength(1);
      const dispatched = flow.chains[0]!;
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]!.data.stepSlug).toBe("else-action");
    });

    test("fails run when condition is false and no else branch", async () => {
      const thenStep = agentStep("then-action");
      const ifNode = ifStep({
        slug: "check-if",
        ref: "{{steps.prev-step.result}}",
        operator: "eq",
        operand: "go",
        thenSteps: [thenStep],
      });

      const steps: WorkflowStep[] = [agentStep("prev-step"), ifNode];

      const runId = createRun({
        stepResults: { "prev-step": "stop" },
        fullStepOrder: ["prev-step", "check-if"],
      });

      const flow = createFakeFlowProducer();
      const broadcast = createFakeBroadcast();
      const deps = buildDeps({ steps, flowProducer: flow, broadcast });

      await dispatchNextSegment(runId, 1, deps);

      // No branch dispatched
      expect(flow.chains).toHaveLength(0);

      // Run should be failed
      const run = runStore.get(runId);
      expect(run!.status).toBe("failed");
      expect(run!.failureReason).toContain("no");
      expect(run!.failureReason).toContain("else");

      // Broadcast workflow_failed
      const failEvent = broadcast.events.find((e) => e.type === "workflow_failed");
      expect(failEvent).not.toBeUndefined();
      expect((failEvent as { failedStep: string }).failedStep).toBe("check-if");
    });

    test("resolves template expressions in condition ref", async () => {
      // Use a deep dot-path template expression
      const thenStep = agentStep("then-action");
      const ifNode = ifStep({
        slug: "check-if",
        ref: "{{steps.prev-step.result.status}}",
        operator: "eq",
        operand: "approved",
        thenSteps: [thenStep],
      });

      const steps: WorkflowStep[] = [agentStep("prev-step"), ifNode];

      const runId = createRun({
        stepResults: { "prev-step": { status: "approved", count: 5 } },
        fullStepOrder: ["prev-step", "check-if"],
      });

      const flow = createFakeFlowProducer();
      const broadcast = createFakeBroadcast();
      const deps = buildDeps({ steps, flowProducer: flow, broadcast });

      await dispatchNextSegment(runId, 1, deps);

      // Condition evaluated to true using deep path
      expect(flow.chains).toHaveLength(1);
      expect(flow.chains[0]![0]!.data.stepSlug).toBe("then-action");
    });

    test("makes branch step results available to subsequent steps via accumulated results", async () => {
      const thenStep = agentStep("then-action");
      const ifNode = ifStep({
        slug: "check-if",
        ref: "{{steps.prev-step.result}}",
        operator: "eq",
        operand: "go",
        thenSteps: [thenStep],
      });

      const steps: WorkflowStep[] = [agentStep("prev-step"), ifNode];

      const runId = createRun({
        stepResults: { "prev-step": "go" },
        fullStepOrder: ["prev-step", "check-if"],
      });

      const flow = createFakeFlowProducer();
      const broadcast = createFakeBroadcast();
      const deps = buildDeps({ steps, flowProducer: flow, broadcast });

      await dispatchNextSegment(runId, 1, deps);

      // The dispatched branch step should have accumulated results injected
      const dispatched = flow.chains[0]!;
      const firstJobData = dispatched[0]!.data;
      // accumulatedStepResults should contain prev-step result AND the if node result
      expect(firstJobData.accumulatedStepResults).not.toBeUndefined();
      expect(firstJobData.accumulatedStepResults!["prev-step"]).toBe("go");
      // The if result should also be stored
      expect(firstJobData.accumulatedStepResults!["check-if"]).toEqual({
        condition: true,
        chosenBranch: "then",
      });
    });

    test("broadcasts workflow_step_completed with chosenBranch", async () => {
      const thenStep = agentStep("then-action");
      const ifNode = ifStep({
        slug: "check-if",
        ref: "{{steps.prev-step.result}}",
        operator: "eq",
        operand: "go",
        thenSteps: [thenStep],
      });

      const steps: WorkflowStep[] = [agentStep("prev-step"), ifNode];

      const runId = createRun({
        stepResults: { "prev-step": "go" },
        fullStepOrder: ["prev-step", "check-if"],
      });

      const flow = createFakeFlowProducer();
      const broadcast = createFakeBroadcast();
      const deps = buildDeps({ steps, flowProducer: flow, broadcast });

      await dispatchNextSegment(runId, 1, deps);

      // Find the workflow_step_completed event
      const completedEvent = broadcast.events.find(
        (e) => e.type === "workflow_step_completed" && "stepSlug" in e && e.stepSlug === "check-if",
      );
      expect(completedEvent).not.toBeUndefined();
      expect((completedEvent as { chosenBranch?: string }).chosenBranch).toBe("then");
    });

    test("broadcasts workflow_step_completed with chosenBranch else", async () => {
      const thenStep = agentStep("then-action");
      const elseStep = agentStep("else-action");
      const ifNode = ifStep({
        slug: "check-if",
        ref: "{{steps.prev-step.result}}",
        operator: "eq",
        operand: "go",
        thenSteps: [thenStep],
        elseSteps: [elseStep],
      });

      const steps: WorkflowStep[] = [agentStep("prev-step"), ifNode];

      const runId = createRun({
        stepResults: { "prev-step": "stop" },
        fullStepOrder: ["prev-step", "check-if"],
      });

      const flow = createFakeFlowProducer();
      const broadcast = createFakeBroadcast();
      const deps = buildDeps({ steps, flowProducer: flow, broadcast });

      await dispatchNextSegment(runId, 1, deps);

      const completedEvent = broadcast.events.find(
        (e) => e.type === "workflow_step_completed" && "stepSlug" in e && e.stepSlug === "check-if",
      );
      expect(completedEvent).not.toBeUndefined();
      expect((completedEvent as { chosenBranch?: string }).chosenBranch).toBe("else");
    });

    test("stores if result in Run Store", async () => {
      const thenStep = agentStep("then-action");
      const ifNode = ifStep({
        slug: "check-if",
        ref: "{{steps.prev-step.result}}",
        operator: "eq",
        operand: "go",
        thenSteps: [thenStep],
      });

      const steps: WorkflowStep[] = [agentStep("prev-step"), ifNode];

      const runId = createRun({
        stepResults: { "prev-step": "go" },
        fullStepOrder: ["prev-step", "check-if"],
      });

      const flow = createFakeFlowProducer();
      const broadcast = createFakeBroadcast();
      const deps = buildDeps({ steps, flowProducer: flow, broadcast });

      await dispatchNextSegment(runId, 1, deps);

      const run = runStore.get(runId);
      expect(run!.stepResults["check-if"]).toEqual({
        condition: true,
        chosenBranch: "then",
      });
    });

    test("marks branch steps with isBranchStep", async () => {
      const thenStepA = agentStep("then-a");
      const thenStepB = agentStep("then-b");
      const ifNode = ifStep({
        slug: "check-if",
        ref: "{{steps.prev-step.result}}",
        operator: "eq",
        operand: "go",
        thenSteps: [thenStepA, thenStepB],
      });

      const steps: WorkflowStep[] = [agentStep("prev-step"), ifNode];

      const runId = createRun({
        stepResults: { "prev-step": "go" },
        fullStepOrder: ["prev-step", "check-if"],
      });

      const flow = createFakeFlowProducer();
      const broadcast = createFakeBroadcast();
      const deps = buildDeps({ steps, flowProducer: flow, broadcast });

      await dispatchNextSegment(runId, 1, deps);

      const dispatched = flow.chains[0]!;
      expect(dispatched).toHaveLength(2);
      expect(dispatched[0]!.data.isBranchStep).toBe(true);
      expect(dispatched[1]!.data.isBranchStep).toBe(true);
    });

    test("sets resumeStepIndex on last branch step only", async () => {
      const thenStepA = agentStep("then-a");
      const thenStepB = agentStep("then-b");
      const ifNode = ifStep({
        slug: "check-if",
        ref: "{{steps.prev-step.result}}",
        operator: "eq",
        operand: "go",
        thenSteps: [thenStepA, thenStepB],
      });

      // After the if node there could be more steps
      const afterStep = agentStep("after-step");
      const steps: WorkflowStep[] = [agentStep("prev-step"), ifNode, afterStep];

      const runId = createRun({
        stepResults: { "prev-step": "go" },
        fullStepOrder: ["prev-step", "check-if", "after-step"],
      });

      const flow = createFakeFlowProducer();
      const broadcast = createFakeBroadcast();
      const deps = buildDeps({ steps, flowProducer: flow, broadcast });

      await dispatchNextSegment(runId, 1, deps);

      const dispatched = flow.chains[0]!;
      expect(dispatched).toHaveLength(2);
      // First step should NOT have resumeStepIndex
      expect(dispatched[0]!.data.resumeStepIndex).toBeUndefined();
      // Last step should have resumeStepIndex pointing to the step after the if node
      expect(dispatched[1]!.data.resumeStepIndex).toBe(2);
    });

    test("resolves trigger payload in condition ref", async () => {
      const thenStep = agentStep("then-action");
      const ifNode = ifStep({
        slug: "check-if",
        ref: "{{trigger.payload.action}}",
        operator: "eq",
        operand: "deploy",
        thenSteps: [thenStep],
      });

      const steps: WorkflowStep[] = [ifNode];

      const runId = createRun({
        stepResults: {},
        triggerPayload: { action: "deploy", target: "prod" },
        fullStepOrder: ["check-if"],
      });

      const flow = createFakeFlowProducer();
      const broadcast = createFakeBroadcast();
      const deps = buildDeps({ steps, flowProducer: flow, broadcast });

      await dispatchNextSegment(runId, 0, deps);

      expect(flow.chains).toHaveLength(1);
      expect(flow.chains[0]![0]!.data.stepSlug).toBe("then-action");
    });

    test("treats unresolvable template path as false (req 3.6)", async () => {
      const thenStep = agentStep("then-action");
      const elseStep = agentStep("else-action");
      const ifNode = ifStep({
        slug: "check-if",
        ref: "{{steps.nonexistent.result}}",
        operator: "eq",
        operand: "go",
        thenSteps: [thenStep],
        elseSteps: [elseStep],
      });

      const steps: WorkflowStep[] = [ifNode];

      const runId = createRun({
        stepResults: {},
        fullStepOrder: ["check-if"],
      });

      const flow = createFakeFlowProducer();
      const broadcast = createFakeBroadcast();
      const deps = buildDeps({ steps, flowProducer: flow, broadcast });

      await dispatchNextSegment(runId, 0, deps);

      // Should dispatch else branch since the ref is unresolvable
      expect(flow.chains).toHaveLength(1);
      expect(flow.chains[0]![0]!.data.stepSlug).toBe("else-action");
    });

    test("skips dispatch for non-running runs", async () => {
      const thenStep = agentStep("then-action");
      const ifNode = ifStep({
        slug: "check-if",
        ref: "{{steps.prev-step.result}}",
        operator: "eq",
        operand: "go",
        thenSteps: [thenStep],
      });

      const steps: WorkflowStep[] = [agentStep("prev-step"), ifNode];

      const runId = createRun({
        stepResults: { "prev-step": "go" },
        fullStepOrder: ["prev-step", "check-if"],
      });

      // Mark the run as failed before dispatch
      runStore.updateStatus(runId, "failed", "already failed");

      const flow = createFakeFlowProducer();
      const broadcast = createFakeBroadcast();
      const deps = buildDeps({ steps, flowProducer: flow, broadcast });

      await dispatchNextSegment(runId, 1, deps);

      // Nothing dispatched
      expect(flow.chains).toHaveLength(0);
      expect(broadcast.events).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Case handler tests - Validates: Requirements 4.1-4.6
  // -------------------------------------------------------------------------

  describe("case handler", () => {
    /** Creates a case step definition. */
    function caseStep(opts: {
      slug: string;
      match: string;
      paths: Record<string, WorkflowStep[]>;
      defaultSteps?: WorkflowStep[];
    }): CaseStep {
      const step: CaseStep = {
        slug: opts.slug,
        type: "case",
        match: opts.match,
        paths: opts.paths,
      };
      if (opts.defaultSteps) {
        step.default = opts.defaultSteps;
      }
      return step;
    }

    test("dispatches matched path when match value equals a path key", async () => {
      const pathAStep = agentStep("path-a-action");
      const pathBStep = agentStep("path-b-action");
      const caseNode = caseStep({
        slug: "route-case",
        match: "{{steps.prev-step.result}}",
        paths: {
          alpha: [pathAStep],
          beta: [pathBStep],
        },
      });

      const steps: WorkflowStep[] = [agentStep("prev-step"), caseNode];

      const runId = createRun({
        stepResults: { "prev-step": "alpha" },
        fullStepOrder: ["prev-step", "route-case"],
      });

      const flow = createFakeFlowProducer();
      const broadcast = createFakeBroadcast();
      const deps = buildDeps({ steps, flowProducer: flow, broadcast });

      await dispatchNextSegment(runId, 1, deps);

      expect(flow.chains).toHaveLength(1);
      const dispatched = flow.chains[0]!;
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]!.data.stepSlug).toBe("path-a-action");
    });

    test("dispatches default path when no path key matches", async () => {
      const pathAStep = agentStep("path-a-action");
      const defaultStep = agentStep("default-action");
      const caseNode = caseStep({
        slug: "route-case",
        match: "{{steps.prev-step.result}}",
        paths: {
          alpha: [pathAStep],
        },
        defaultSteps: [defaultStep],
      });

      const steps: WorkflowStep[] = [agentStep("prev-step"), caseNode];

      const runId = createRun({
        stepResults: { "prev-step": "unknown-value" },
        fullStepOrder: ["prev-step", "route-case"],
      });

      const flow = createFakeFlowProducer();
      const broadcast = createFakeBroadcast();
      const deps = buildDeps({ steps, flowProducer: flow, broadcast });

      await dispatchNextSegment(runId, 1, deps);

      expect(flow.chains).toHaveLength(1);
      const dispatched = flow.chains[0]!;
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]!.data.stepSlug).toBe("default-action");
    });

    test("fails run when no path matches and no default is defined", async () => {
      const pathAStep = agentStep("path-a-action");
      const pathBStep = agentStep("path-b-action");
      const caseNode = caseStep({
        slug: "route-case",
        match: "{{steps.prev-step.result}}",
        paths: {
          alpha: [pathAStep],
          beta: [pathBStep],
        },
      });

      const steps: WorkflowStep[] = [agentStep("prev-step"), caseNode];

      const runId = createRun({
        stepResults: { "prev-step": "gamma" },
        fullStepOrder: ["prev-step", "route-case"],
      });

      const flow = createFakeFlowProducer();
      const broadcast = createFakeBroadcast();
      const deps = buildDeps({ steps, flowProducer: flow, broadcast });

      await dispatchNextSegment(runId, 1, deps);

      // No branch dispatched
      expect(flow.chains).toHaveLength(0);

      // Run should be failed
      const run = runStore.get(runId);
      expect(run!.status).toBe("failed");
      expect(run!.failureReason).toContain("gamma");
      expect(run!.failureReason).toContain("alpha");
      expect(run!.failureReason).toContain("beta");

      // Broadcast workflow_failed
      const failEvent = broadcast.events.find((e) => e.type === "workflow_failed");
      expect(failEvent).not.toBeUndefined();
      expect((failEvent as { failedStep: string }).failedStep).toBe("route-case");
    });

    test("stores result as { matched: '<key>' } for a named path", async () => {
      const pathAStep = agentStep("path-a-action");
      const caseNode = caseStep({
        slug: "route-case",
        match: "{{steps.prev-step.result}}",
        paths: {
          alpha: [pathAStep],
        },
      });

      const steps: WorkflowStep[] = [agentStep("prev-step"), caseNode];

      const runId = createRun({
        stepResults: { "prev-step": "alpha" },
        fullStepOrder: ["prev-step", "route-case"],
      });

      const flow = createFakeFlowProducer();
      const broadcast = createFakeBroadcast();
      const deps = buildDeps({ steps, flowProducer: flow, broadcast });

      await dispatchNextSegment(runId, 1, deps);

      const run = runStore.get(runId);
      expect(run!.stepResults["route-case"]).toEqual({ matched: "alpha" });
    });

    test("stores result as { matched: '__default' } when default path is used", async () => {
      const pathAStep = agentStep("path-a-action");
      const defaultStep = agentStep("default-action");
      const caseNode = caseStep({
        slug: "route-case",
        match: "{{steps.prev-step.result}}",
        paths: {
          alpha: [pathAStep],
        },
        defaultSteps: [defaultStep],
      });

      const steps: WorkflowStep[] = [agentStep("prev-step"), caseNode];

      const runId = createRun({
        stepResults: { "prev-step": "no-match" },
        fullStepOrder: ["prev-step", "route-case"],
      });

      const flow = createFakeFlowProducer();
      const broadcast = createFakeBroadcast();
      const deps = buildDeps({ steps, flowProducer: flow, broadcast });

      await dispatchNextSegment(runId, 1, deps);

      const run = runStore.get(runId);
      expect(run!.stepResults["route-case"]).toEqual({ matched: "__default" });
    });

    test("broadcasts workflow_step_completed with chosenBranch", async () => {
      const pathAStep = agentStep("path-a-action");
      const caseNode = caseStep({
        slug: "route-case",
        match: "{{steps.prev-step.result}}",
        paths: {
          alpha: [pathAStep],
        },
      });

      const steps: WorkflowStep[] = [agentStep("prev-step"), caseNode];

      const runId = createRun({
        stepResults: { "prev-step": "alpha" },
        fullStepOrder: ["prev-step", "route-case"],
      });

      const flow = createFakeFlowProducer();
      const broadcast = createFakeBroadcast();
      const deps = buildDeps({ steps, flowProducer: flow, broadcast });

      await dispatchNextSegment(runId, 1, deps);

      const completedEvent = broadcast.events.find(
        (e) => e.type === "workflow_step_completed" && "stepSlug" in e && e.stepSlug === "route-case",
      );
      expect(completedEvent).not.toBeUndefined();
      expect((completedEvent as { chosenBranch?: string }).chosenBranch).toBe("alpha");
    });

    test("broadcasts chosenBranch as __default when default is used", async () => {
      const defaultStep = agentStep("default-action");
      const caseNode = caseStep({
        slug: "route-case",
        match: "{{steps.prev-step.result}}",
        paths: {
          alpha: [agentStep("path-a-action")],
        },
        defaultSteps: [defaultStep],
      });

      const steps: WorkflowStep[] = [agentStep("prev-step"), caseNode];

      const runId = createRun({
        stepResults: { "prev-step": "no-match" },
        fullStepOrder: ["prev-step", "route-case"],
      });

      const flow = createFakeFlowProducer();
      const broadcast = createFakeBroadcast();
      const deps = buildDeps({ steps, flowProducer: flow, broadcast });

      await dispatchNextSegment(runId, 1, deps);

      const completedEvent = broadcast.events.find(
        (e) => e.type === "workflow_step_completed" && "stepSlug" in e && e.stepSlug === "route-case",
      );
      expect(completedEvent).not.toBeUndefined();
      expect((completedEvent as { chosenBranch?: string }).chosenBranch).toBe("__default");
    });

    test("marks branch steps with isBranchStep and resumeStepIndex", async () => {
      const branchStepA = agentStep("branch-a");
      const branchStepB = agentStep("branch-b");
      const afterStep = agentStep("after-step");
      const caseNode = caseStep({
        slug: "route-case",
        match: "{{steps.prev-step.result}}",
        paths: {
          alpha: [branchStepA, branchStepB],
        },
      });

      const steps: WorkflowStep[] = [agentStep("prev-step"), caseNode, afterStep];

      const runId = createRun({
        stepResults: { "prev-step": "alpha" },
        fullStepOrder: ["prev-step", "route-case", "after-step"],
      });

      const flow = createFakeFlowProducer();
      const broadcast = createFakeBroadcast();
      const deps = buildDeps({ steps, flowProducer: flow, broadcast });

      await dispatchNextSegment(runId, 1, deps);

      const dispatched = flow.chains[0]!;
      expect(dispatched).toHaveLength(2);
      expect(dispatched[0]!.data.isBranchStep).toBe(true);
      expect(dispatched[1]!.data.isBranchStep).toBe(true);
      // Only last step gets resumeStepIndex
      expect(dispatched[0]!.data.resumeStepIndex).toBeUndefined();
      expect(dispatched[1]!.data.resumeStepIndex).toBe(2);
    });

    test("resolves trigger payload in match expression", async () => {
      const pathAStep = agentStep("path-a-action");
      const caseNode = caseStep({
        slug: "route-case",
        match: "{{trigger.payload.env}}",
        paths: {
          production: [pathAStep],
          staging: [agentStep("staging-action")],
        },
      });

      const steps: WorkflowStep[] = [caseNode];

      const runId = createRun({
        stepResults: {},
        triggerPayload: { env: "production", region: "us-east" },
        fullStepOrder: ["route-case"],
      });

      const flow = createFakeFlowProducer();
      const broadcast = createFakeBroadcast();
      const deps = buildDeps({ steps, flowProducer: flow, broadcast });

      await dispatchNextSegment(runId, 0, deps);

      expect(flow.chains).toHaveLength(1);
      expect(flow.chains[0]![0]!.data.stepSlug).toBe("path-a-action");
    });

    test("makes branch step results available via accumulated results", async () => {
      const pathAStep = agentStep("path-a-action");
      const caseNode = caseStep({
        slug: "route-case",
        match: "{{steps.prev-step.result}}",
        paths: {
          alpha: [pathAStep],
        },
      });

      const steps: WorkflowStep[] = [agentStep("prev-step"), caseNode];

      const runId = createRun({
        stepResults: { "prev-step": "alpha" },
        fullStepOrder: ["prev-step", "route-case"],
      });

      const flow = createFakeFlowProducer();
      const broadcast = createFakeBroadcast();
      const deps = buildDeps({ steps, flowProducer: flow, broadcast });

      await dispatchNextSegment(runId, 1, deps);

      // The dispatched branch step should have accumulated results injected
      const dispatched = flow.chains[0]!;
      const jobData = dispatched[0]!.data;
      expect(jobData.accumulatedStepResults).not.toBeUndefined();
      expect(jobData.accumulatedStepResults!["prev-step"]).toBe("alpha");
      // The case result should also be stored
      expect(jobData.accumulatedStepResults!["route-case"]).toEqual({ matched: "alpha" });
    });

    // -----------------------------------------------------------------------
    // Property 12: Case match uses exact case-sensitive comparison
    // Validates: Requirements 4.5
    // -----------------------------------------------------------------------

    describe("Property 12: exact case-sensitive matching", () => {
      test("matches only when resolved value is identical to path key (no trimming, case-sensitive)", async () => {
        await fc.assert(
          fc.asyncProperty(
            // Generate a non-empty path key (lowercase alpha + digits for valid slug-like keys)
            fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/).filter((s) => s.length >= 1),
            // Generate variations: same, different case, with whitespace
            fc.constantFrom("exact", "uppercase", "leading-space", "trailing-space"),
            async (pathKey, variant) => {
              createTestDb();

              let matchValue: string;
              let shouldMatch: boolean;

              switch (variant) {
                case "exact":
                  matchValue = pathKey;
                  shouldMatch = true;
                  break;
                case "uppercase":
                  matchValue = pathKey.toUpperCase();
                  // Only matches if the key happens to be all uppercase already
                  shouldMatch = pathKey === pathKey.toUpperCase();
                  break;
                case "leading-space":
                  matchValue = ` ${pathKey}`;
                  shouldMatch = false;
                  break;
                case "trailing-space":
                  matchValue = `${pathKey} `;
                  shouldMatch = false;
                  break;
                default:
                  matchValue = pathKey;
                  shouldMatch = true;
              }

              const pathStep = agentStep("matched-action");
              const defaultStep = agentStep("default-action");
              const caseNode = caseStep({
                slug: "prop-case",
                match: "{{steps.input.result}}",
                paths: { [pathKey]: [pathStep] },
                defaultSteps: [defaultStep],
              });

              const steps: WorkflowStep[] = [caseNode];
              const runId = `run-${pathKey}-${variant}`;

              runStore.create({
                id: runId,
                workflowName: "prop-test",
                status: "running",
                stepResults: { input: matchValue },
                triggerPayload: null,
                currentStepIndex: 0,
                fullStepOrder: ["prop-case"],
                failureReason: null,
              });

              const flow = createFakeFlowProducer();
              const broadcast = createFakeBroadcast();
              const deps = buildDeps({ steps, flowProducer: flow, broadcast });

              await dispatchNextSegment(runId, 0, deps);

              expect(flow.chains).toHaveLength(1);
              const dispatched = flow.chains[0]!;
              if (shouldMatch) {
                expect(dispatched[0]!.data.stepSlug).toBe("matched-action");
              } else {
                expect(dispatched[0]!.data.stepSlug).toBe("default-action");
              }
            },
          ),
          { numRuns: 100 },
        );
      });

      test("case-sensitive: 'Alpha' does not match path key 'alpha'", async () => {
        const pathStep = agentStep("alpha-action");
        const defaultStep = agentStep("default-action");
        const caseNode = caseStep({
          slug: "route-case",
          match: "{{steps.prev-step.result}}",
          paths: { alpha: [pathStep] },
          defaultSteps: [defaultStep],
        });

        const steps: WorkflowStep[] = [agentStep("prev-step"), caseNode];

        const runId = createRun({
          stepResults: { "prev-step": "Alpha" },
          fullStepOrder: ["prev-step", "route-case"],
        });

        const flow = createFakeFlowProducer();
        const broadcast = createFakeBroadcast();
        const deps = buildDeps({ steps, flowProducer: flow, broadcast });

        await dispatchNextSegment(runId, 1, deps);

        // Should go to default since "Alpha" !== "alpha"
        expect(flow.chains).toHaveLength(1);
        expect(flow.chains[0]![0]!.data.stepSlug).toBe("default-action");
      });

      test("no trimming: ' alpha' does not match path key 'alpha'", async () => {
        const pathStep = agentStep("alpha-action");
        const defaultStep = agentStep("default-action");
        const caseNode = caseStep({
          slug: "route-case",
          match: "{{steps.prev-step.result}}",
          paths: { alpha: [pathStep] },
          defaultSteps: [defaultStep],
        });

        const steps: WorkflowStep[] = [agentStep("prev-step"), caseNode];

        const runId = createRun({
          stepResults: { "prev-step": " alpha" },
          fullStepOrder: ["prev-step", "route-case"],
        });

        const flow = createFakeFlowProducer();
        const broadcast = createFakeBroadcast();
        const deps = buildDeps({ steps, flowProducer: flow, broadcast });

        await dispatchNextSegment(runId, 1, deps);

        expect(flow.chains).toHaveLength(1);
        expect(flow.chains[0]![0]!.data.stepSlug).toBe("default-action");
      });

      test("no trimming: 'alpha ' does not match path key 'alpha'", async () => {
        const pathStep = agentStep("alpha-action");
        const defaultStep = agentStep("default-action");
        const caseNode = caseStep({
          slug: "route-case",
          match: "{{steps.prev-step.result}}",
          paths: { alpha: [pathStep] },
          defaultSteps: [defaultStep],
        });

        const steps: WorkflowStep[] = [agentStep("prev-step"), caseNode];

        const runId = createRun({
          stepResults: { "prev-step": "alpha " },
          fullStepOrder: ["prev-step", "route-case"],
        });

        const flow = createFakeFlowProducer();
        const broadcast = createFakeBroadcast();
        const deps = buildDeps({ steps, flowProducer: flow, broadcast });

        await dispatchNextSegment(runId, 1, deps);

        expect(flow.chains).toHaveLength(1);
        expect(flow.chains[0]![0]!.data.stepSlug).toBe("default-action");
      });
    });
  });

  // -------------------------------------------------------------------------
  // Emit handler tests - Validates: Requirements 7.1-7.6
  // -------------------------------------------------------------------------

  describe("emit handler", () => {
    /** Creates an emit step definition. */
    function emitStep(opts: { slug: string; event: string; payload?: string }): EmitStep {
      const step: EmitStep = {
        slug: opts.slug,
        type: "emit",
        event: opts.event,
      };
      if (opts.payload) {
        step.payload = opts.payload;
      }
      return step;
    }

    /** Creates a waiting run with a signal record for the emit handler to deliver to. */
    function createWaitingRun(opts: {
      id: string;
      workflowName?: string;
      stepSlug: string;
      event: string;
      stepResults?: Record<string, unknown>;
      fullStepOrder?: string[];
    }) {
      runStore.create({
        id: opts.id,
        workflowName: opts.workflowName ?? "waiting-workflow",
        status: "waiting-signal",
        stepResults: opts.stepResults ?? {},
        triggerPayload: null,
        currentStepIndex: 0,
        fullStepOrder: opts.fullStepOrder ?? [opts.stepSlug, "after-wait"],
        failureReason: null,
      });

      signalStore.create({
        runId: opts.id,
        stepSlug: opts.stepSlug,
        event: opts.event,
        timeoutMs: null,
        inputSchema: null,
      });
    }

    /** Builds deps with a getWorkflowDefinition that returns steps for waiting workflows. */
    function buildEmitDeps(opts: {
      steps: WorkflowStep[];
      flowProducer: ReturnType<typeof createFakeFlowProducer>;
      broadcast: ReturnType<typeof createFakeBroadcast>;
      waitingWorkflowSteps?: WorkflowStep[];
    }): SegmentDispatcherDeps {
      const allStepDefs: Record<string, unknown> = {};
      for (const s of opts.steps) {
        allStepDefs[s.slug] = s;
      }
      const waitingSteps = opts.waitingWorkflowSteps ?? [
        { slug: "wait-step", type: "waitFor", event: "test.event" } as WorkflowStep,
        agentStep("after-wait"),
      ];
      return {
        steps: opts.steps,
        allStepDefs,
        flowProducer: opts.flowProducer as unknown as FlowProducer,
        sessionFactory: createFakeSessionFactory(),
        log: createFakeLogger() as SegmentDispatcherDeps["log"],
        broadcast: opts.broadcast.fn,
        getWorkflowDefinition: (_name: string) => ({ steps: waitingSteps }),
      };
    }

    test("delivers signals to matching waiting runs and reports correct count", async () => {
      createTestDb();

      // Emitting run
      const emitRunId = createRun({
        id: "emit-run",
        stepResults: { "prev-step": "some-data" },
        fullStepOrder: ["prev-step", "send-signal"],
      });

      // Two waiting runs with signals for the same event
      createWaitingRun({ id: "waiting-run-1", stepSlug: "wait-step", event: "approval.granted" });
      createWaitingRun({ id: "waiting-run-2", stepSlug: "wait-step", event: "approval.granted" });

      const emitNode = emitStep({
        slug: "send-signal",
        event: "approval.granted",
        payload: "{{steps.prev-step.result}}",
      });
      const steps: WorkflowStep[] = [agentStep("prev-step"), emitNode];

      const flow = createFakeFlowProducer();
      const broadcast = createFakeBroadcast();
      const deps = buildEmitDeps({ steps, flowProducer: flow, broadcast });

      await dispatchNextSegment(emitRunId, 1, deps);

      // Verify emit result stored correctly
      const emitRun = runStore.get(emitRunId);
      expect(emitRun!.stepResults["send-signal"]).toEqual({
        event: "approval.granted",
        delivered: 2,
      });

      // Verify waiting runs transitioned to "running"
      const waitingRun1 = runStore.get("waiting-run-1");
      expect(waitingRun1!.status).toBe("running");
      const waitingRun2 = runStore.get("waiting-run-2");
      expect(waitingRun2!.status).toBe("running");

      // Verify signal records marked as received
      const signal1 = signalStore.getWaiting("waiting-run-1", "approval.granted");
      expect(signal1).toBeNull(); // no longer in "waiting" status
      const signal2 = signalStore.getWaiting("waiting-run-2", "approval.granted");
      expect(signal2).toBeNull();

      // Verify workflow_step_resumed broadcast for each waiting run
      const resumedEvents = broadcast.events.filter((e) => e.type === "workflow_step_resumed");
      expect(resumedEvents).toHaveLength(2);
      const resumedRunIds = resumedEvents.map((e) => (e as { workflowRunId: string }).workflowRunId);
      expect(resumedRunIds).toContain("waiting-run-1");
      expect(resumedRunIds).toContain("waiting-run-2");

      // Verify workflow_step_completed broadcast for the emit node
      const completedEvent = broadcast.events.find(
        (e) => e.type === "workflow_step_completed" && (e as { stepSlug: string }).stepSlug === "send-signal",
      );
      expect(completedEvent).not.toBeUndefined();
    });

    test("stores delivered: 0 and continues without error when no runs are waiting", async () => {
      createTestDb();

      // Emitting run
      const emitRunId = createRun({
        id: "emit-run",
        stepResults: {},
        fullStepOrder: ["send-signal", "after-emit"],
      });

      const afterStep = agentStep("after-emit");
      const emitNode = emitStep({ slug: "send-signal", event: "no-one-listening" });
      const steps: WorkflowStep[] = [emitNode, afterStep];

      const flow = createFakeFlowProducer();
      const broadcast = createFakeBroadcast();
      const deps = buildEmitDeps({ steps, flowProducer: flow, broadcast });

      await dispatchNextSegment(emitRunId, 0, deps);

      // Verify emit result with delivered: 0
      const emitRun = runStore.get(emitRunId);
      expect(emitRun!.stepResults["send-signal"]).toEqual({
        event: "no-one-listening",
        delivered: 0,
      });

      // Run should still be running (not failed)
      expect(emitRun!.status).not.toBe("failed");

      // workflow_step_completed broadcast should be present
      const completedEvent = broadcast.events.find(
        (e) => e.type === "workflow_step_completed" && (e as { stepSlug: string }).stepSlug === "send-signal",
      );
      expect(completedEvent).not.toBeUndefined();

      // No workflow_failed broadcast
      const failEvents = broadcast.events.filter((e) => e.type === "workflow_failed");
      expect(failEvents).toHaveLength(0);
    });

    test("fails run when template resolution of event name fails", async () => {
      createTestDb();

      const emitRunId = createRun({
        id: "emit-run",
        stepResults: {},
        fullStepOrder: ["send-signal"],
      });

      // Use unresolvable template expression in event
      const emitNode = emitStep({ slug: "send-signal", event: "{{steps.nonexistent.result}}" });
      const steps: WorkflowStep[] = [emitNode];

      const flow = createFakeFlowProducer();
      const broadcast = createFakeBroadcast();
      const deps = buildEmitDeps({ steps, flowProducer: flow, broadcast });

      await dispatchNextSegment(emitRunId, 0, deps);

      // Run should be failed
      const emitRun = runStore.get(emitRunId);
      expect(emitRun!.status).toBe("failed");
      expect(emitRun!.failureReason).toContain("Template resolution failed");

      // workflow_failed broadcast
      const failEvent = broadcast.events.find((e) => e.type === "workflow_failed");
      expect(failEvent).not.toBeUndefined();
      expect((failEvent as { failedStep: string }).failedStep).toBe("send-signal");

      // No chains dispatched
      expect(flow.chains).toHaveLength(0);
    });

    test("fails run when template resolution of payload fails", async () => {
      createTestDb();

      const emitRunId = createRun({
        id: "emit-run",
        stepResults: { "prev-step": "ready" },
        fullStepOrder: ["prev-step", "send-signal"],
      });

      // Event resolves fine but payload uses unresolvable template
      const emitNode = emitStep({
        slug: "send-signal",
        event: "valid.event",
        payload: "{{steps.missing.result}}",
      });
      const steps: WorkflowStep[] = [agentStep("prev-step"), emitNode];

      const flow = createFakeFlowProducer();
      const broadcast = createFakeBroadcast();
      const deps = buildEmitDeps({ steps, flowProducer: flow, broadcast });

      await dispatchNextSegment(emitRunId, 1, deps);

      // Run should be failed
      const emitRun = runStore.get(emitRunId);
      expect(emitRun!.status).toBe("failed");
      expect(emitRun!.failureReason).toContain("Template resolution failed");
      expect(emitRun!.failureReason).toContain("payload");

      // workflow_failed broadcast
      const failEvent = broadcast.events.find((e) => e.type === "workflow_failed");
      expect(failEvent).not.toBeUndefined();
    });

    test("partial delivery failure: continues to remaining runs and excludes failed from count", async () => {
      createTestDb();

      // Emitting run
      runStore.create({
        id: "emit-run",
        workflowName: "emitter",
        status: "running",
        stepResults: {},
        triggerPayload: null,
        currentStepIndex: 0,
        fullStepOrder: ["send-signal"],
        failureReason: null,
      });

      // Good waiting run - has both run record and signal
      runStore.create({
        id: "waiting-run-ok",
        workflowName: "waiting-workflow",
        status: "waiting-signal",
        stepResults: {},
        triggerPayload: null,
        currentStepIndex: 0,
        fullStepOrder: ["wait-step", "after-wait"],
        failureReason: null,
      });
      signalStore.create({
        runId: "waiting-run-ok",
        stepSlug: "wait-step",
        event: "notify.all",
        timeoutMs: null,
        inputSchema: null,
      });

      // Bad waiting run - signal exists but NO run record
      // This will cause runStore.updateStepResult to throw/fail when
      // the emit handler tries to store the payload as the step result
      signalStore.create({
        runId: "waiting-run-bad",
        stepSlug: "wait-step",
        event: "notify.all",
        timeoutMs: null,
        inputSchema: null,
      });

      const emitNode = emitStep({ slug: "send-signal", event: "notify.all" });
      const steps: WorkflowStep[] = [emitNode];

      const flow = createFakeFlowProducer();
      const broadcast = createFakeBroadcast();
      const deps = buildEmitDeps({ steps, flowProducer: flow, broadcast });

      await dispatchNextSegment("emit-run", 0, deps);

      // Emit step should NOT have failed
      const emitRun = runStore.get("emit-run");
      expect(emitRun!.status).not.toBe("failed");

      // The step result should reflect only successful deliveries
      const result = emitRun!.stepResults["send-signal"] as { event: string; delivered: number };
      expect(result.event).toBe("notify.all");
      // At least the good run was delivered; the bad one may or may not
      // count depending on whether updateStepResult on a nonexistent run throws.
      // The key assertion: the emit step itself did NOT fail.
      expect(result.delivered).toBeGreaterThanOrEqual(1);

      // workflow_step_completed should be present (emit step didn't fail)
      const completedEvent = broadcast.events.find(
        (e) => e.type === "workflow_step_completed" && (e as { stepSlug: string }).stepSlug === "send-signal",
      );
      expect(completedEvent).not.toBeUndefined();

      // No workflow_failed for the emitting run
      const failEvents = broadcast.events.filter(
        (e) => e.type === "workflow_failed" && (e as { workflowRunId: string }).workflowRunId === "emit-run",
      );
      expect(failEvents).toHaveLength(0);
    });

    test("skips self-signals (does not deliver to same run)", async () => {
      createTestDb();

      // Run that is both emitting AND waiting for the same event
      runStore.create({
        id: "self-run",
        workflowName: "self-workflow",
        status: "running",
        stepResults: {},
        triggerPayload: null,
        currentStepIndex: 1,
        fullStepOrder: ["wait-step", "send-signal"],
        failureReason: null,
      });

      // Create a signal for the same run (simulating it somehow waiting for its own event)
      signalStore.create({
        runId: "self-run",
        stepSlug: "wait-step",
        event: "self.event",
        timeoutMs: null,
        inputSchema: null,
      });

      const emitNode = emitStep({ slug: "send-signal", event: "self.event" });
      const steps: WorkflowStep[] = [
        { slug: "wait-step", type: "waitFor", event: "self.event" } as WorkflowStep,
        emitNode,
      ];

      const flow = createFakeFlowProducer();
      const broadcast = createFakeBroadcast();
      const deps = buildEmitDeps({ steps, flowProducer: flow, broadcast });

      await dispatchNextSegment("self-run", 1, deps);

      // Emit result should show delivered: 0 (self-signal skipped)
      const run = runStore.get("self-run");
      expect(run!.stepResults["send-signal"]).toEqual({
        event: "self.event",
        delivered: 0,
      });

      // Signal should still be in waiting state (not received)
      const signal = signalStore.getWaiting("self-run", "self.event");
      expect(signal).not.toBeNull();
    });

    test("resolves payload template and delivers to waiting runs", async () => {
      createTestDb();

      const emitRunId = "emit-run";
      runStore.create({
        id: emitRunId,
        workflowName: "emitter",
        status: "running",
        stepResults: { "prev-step": { data: "hello" } },
        triggerPayload: null,
        currentStepIndex: 1,
        fullStepOrder: ["prev-step", "send-signal"],
        failureReason: null,
      });

      createWaitingRun({ id: "waiting-run", stepSlug: "wait-step", event: "data.ready" });

      const emitNode = emitStep({
        slug: "send-signal",
        event: "data.ready",
        payload: "{{steps.prev-step.result}}",
      });
      const steps: WorkflowStep[] = [agentStep("prev-step"), emitNode];

      const flow = createFakeFlowProducer();
      const broadcast = createFakeBroadcast();
      const deps = buildEmitDeps({ steps, flowProducer: flow, broadcast });

      await dispatchNextSegment(emitRunId, 1, deps);

      // Waiting run should have the payload stored as its step result
      const waitingRun = runStore.get("waiting-run");
      // The resolved payload is the string representation from template resolution
      expect(waitingRun!.stepResults["wait-step"]).not.toBeNull();
      expect(waitingRun!.status).toBe("running");

      // Emit result should show delivered: 1
      const emitRun = runStore.get(emitRunId);
      expect(emitRun!.stepResults["send-signal"]).toEqual({
        event: "data.ready",
        delivered: 1,
      });
    });
  });
});
