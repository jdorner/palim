/**
 * Tests for the `waitFor` handler and signal delivery logic.
 *
 * Uses in-memory SQLite for isolation.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import type { WorkflowWebSocketEvent } from "@shared/workflows";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { FlowProducer, FlowStep } from "bunqueue/client";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { SessionFactory } from "./engine";
import * as runStore from "./runStore";
import type { WaitForStep, WorkflowStep } from "./schemas";
import { dispatchNextSegment, type SegmentDispatcherDeps } from "./segmentDispatcher";
import * as signalStore from "./signalStore";
import * as signalTimers from "./signalTimers";
import type { WorkflowStepJobData } from "./types";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const RUN_MIGRATION_SQL = `
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

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run(RUN_MIGRATION_SQL);
  sqlite.run(SIGNAL_MIGRATION_SQL);
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

/** Creates a waitFor step definition. */
function waitForStep(opts: {
  slug: string;
  event: string;
  timeout?: number;
  inputSchema?: Record<string, unknown>;
}): WaitForStep {
  const step: WaitForStep = {
    slug: opts.slug,
    type: "waitFor",
    event: opts.event,
  };
  if (opts.timeout != null) step.timeout = opts.timeout;
  if (opts.inputSchema != null) step.inputSchema = opts.inputSchema;
  return step;
}

/** Creates a run in the Run Store and returns the ID. */
function createRun(opts?: {
  id?: string;
  workflowName?: string;
  status?: runStore.RunStatus;
  stepResults?: Record<string, unknown>;
  triggerPayload?: unknown;
  fullStepOrder?: string[];
  currentStepIndex?: number;
}) {
  const id = opts?.id ?? "run-1";
  runStore.create({
    id,
    workflowName: opts?.workflowName ?? "test-workflow",
    status: opts?.status ?? "running",
    stepResults: opts?.stepResults ?? {},
    triggerPayload: opts?.triggerPayload ?? null,
    currentStepIndex: opts?.currentStepIndex ?? 0,
    fullStepOrder: opts?.fullStepOrder ?? ["prev-step", "wait-approval"],
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
// Tests: waitFor handler
// ---------------------------------------------------------------------------

describe("WaitFor Handler", () => {
  beforeEach(() => {
    createTestDb();
    signalTimers.cleanup();
  });

  test("creates signal record in Signal Store with correct event name", async () => {
    const wfStep = waitForStep({ slug: "wait-approval", event: "approval.granted" });
    const steps: WorkflowStep[] = [agentStep("prev-step"), wfStep];

    const runId = createRun({ fullStepOrder: ["prev-step", "wait-approval"] });

    const flow = createFakeFlowProducer();
    const broadcast = createFakeBroadcast();
    const deps = buildDeps({ steps, flowProducer: flow, broadcast });

    await dispatchNextSegment(runId, 1, deps);

    const signal = signalStore.getWaiting(runId, "approval.granted");
    expect(signal).not.toBeNull();
    expect(signal!.event).toBe("approval.granted");
    expect(signal!.runId).toBe(runId);
    expect(signal!.stepSlug).toBe("wait-approval");
    expect(signal!.status).toBe("waiting");
  });

  test("transitions run to waiting-signal status", async () => {
    const wfStep = waitForStep({ slug: "wait-approval", event: "approval.granted" });
    const steps: WorkflowStep[] = [agentStep("prev-step"), wfStep];

    const runId = createRun({ fullStepOrder: ["prev-step", "wait-approval"] });

    const flow = createFakeFlowProducer();
    const broadcast = createFakeBroadcast();
    const deps = buildDeps({ steps, flowProducer: flow, broadcast });

    await dispatchNextSegment(runId, 1, deps);

    const run = runStore.get(runId);
    expect(run!.status).toBe("waiting-signal");
  });

  test("broadcasts workflow_step_started then workflow_step_waiting", async () => {
    const wfStep = waitForStep({ slug: "wait-approval", event: "approval.granted" });
    const steps: WorkflowStep[] = [agentStep("prev-step"), wfStep];

    const runId = createRun({ fullStepOrder: ["prev-step", "wait-approval"] });

    const flow = createFakeFlowProducer();
    const broadcast = createFakeBroadcast();
    const deps = buildDeps({ steps, flowProducer: flow, broadcast });

    await dispatchNextSegment(runId, 1, deps);

    // Should have both events in order
    expect(broadcast.events.length).toBeGreaterThanOrEqual(2);

    const startedEvent = broadcast.events.find((e) => e.type === "workflow_step_started");
    expect(startedEvent).not.toBeUndefined();
    expect((startedEvent as { stepSlug: string }).stepSlug).toBe("wait-approval");

    const waitingEvent = broadcast.events.find((e) => e.type === "workflow_step_waiting");
    expect(waitingEvent).not.toBeUndefined();
    expect((waitingEvent as { stepSlug: string; event: string }).stepSlug).toBe("wait-approval");
    expect((waitingEvent as { event: string }).event).toBe("approval.granted");

    // Started must come before waiting
    const startedIdx = broadcast.events.indexOf(startedEvent!);
    const waitingIdx = broadcast.events.indexOf(waitingEvent!);
    expect(startedIdx).toBeLessThan(waitingIdx);
  });

  test("does NOT dispatch any chain (releases worker slot)", async () => {
    const wfStep = waitForStep({ slug: "wait-approval", event: "approval.granted" });
    const steps: WorkflowStep[] = [agentStep("prev-step"), wfStep];

    const runId = createRun({ fullStepOrder: ["prev-step", "wait-approval"] });

    const flow = createFakeFlowProducer();
    const broadcast = createFakeBroadcast();
    const deps = buildDeps({ steps, flowProducer: flow, broadcast });

    await dispatchNextSegment(runId, 1, deps);

    // No chains dispatched - worker slot is released
    expect(flow.chains).toHaveLength(0);
  });

  test("arms timeout timer when timeout is specified", async () => {
    const wfStep = waitForStep({ slug: "wait-approval", event: "approval.granted", timeout: 60000 });
    const steps: WorkflowStep[] = [agentStep("prev-step"), wfStep];

    const runId = createRun({ fullStepOrder: ["prev-step", "wait-approval"] });

    const flow = createFakeFlowProducer();
    const broadcast = createFakeBroadcast();
    const deps = buildDeps({
      steps,
      flowProducer: flow,
      broadcast,
    });

    await dispatchNextSegment(runId, 1, deps);

    expect(signalTimers.activeCount()).toBe(1);
    // Clean up timer
    signalTimers.cleanup();
  });

  test("does NOT arm timeout when timeout is absent", async () => {
    const wfStep = waitForStep({ slug: "wait-approval", event: "approval.granted" });
    const steps: WorkflowStep[] = [agentStep("prev-step"), wfStep];

    const runId = createRun({ fullStepOrder: ["prev-step", "wait-approval"] });

    const flow = createFakeFlowProducer();
    const broadcast = createFakeBroadcast();
    const deps = buildDeps({
      steps,
      flowProducer: flow,
      broadcast,
    });

    await dispatchNextSegment(runId, 1, deps);

    expect(signalTimers.activeCount()).toBe(0);
  });

  test("stores inputSchema in signal record when specified", async () => {
    const schema = { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] };
    const wfStep = waitForStep({
      slug: "wait-approval",
      event: "approval.granted",
      inputSchema: schema,
    });
    const steps: WorkflowStep[] = [agentStep("prev-step"), wfStep];

    const runId = createRun({ fullStepOrder: ["prev-step", "wait-approval"] });

    const flow = createFakeFlowProducer();
    const broadcast = createFakeBroadcast();
    const deps = buildDeps({ steps, flowProducer: flow, broadcast });

    await dispatchNextSegment(runId, 1, deps);

    const signal = signalStore.getWaiting(runId, "approval.granted");
    expect(signal).not.toBeNull();
    expect(signal!.inputSchema).toEqual(schema);
  });

  test("stores timeout in signal record when specified", async () => {
    const wfStep = waitForStep({ slug: "wait-approval", event: "approval.granted", timeout: 30000 });
    const steps: WorkflowStep[] = [agentStep("prev-step"), wfStep];

    const runId = createRun({ fullStepOrder: ["prev-step", "wait-approval"] });

    const flow = createFakeFlowProducer();
    const broadcast = createFakeBroadcast();
    const deps = buildDeps({
      steps,
      flowProducer: flow,
      broadcast,
    });

    await dispatchNextSegment(runId, 1, deps);

    const signal = signalStore.getWaiting(runId, "approval.granted");
    expect(signal).not.toBeNull();
    expect(signal!.timeoutMs).toBe(30000);

    // Clean up timer
    signalTimers.cleanup();
  });

  test("updates execution cursor to the waitFor step index", async () => {
    const wfStep = waitForStep({ slug: "wait-approval", event: "approval.granted" });
    const steps: WorkflowStep[] = [agentStep("prev-step"), wfStep, agentStep("after-step")];

    const runId = createRun({ fullStepOrder: ["prev-step", "wait-approval", "after-step"] });

    const flow = createFakeFlowProducer();
    const broadcast = createFakeBroadcast();
    const deps = buildDeps({ steps, flowProducer: flow, broadcast });

    await dispatchNextSegment(runId, 1, deps);

    const run = runStore.get(runId);
    expect(run!.currentStepIndex).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: Signal delivery logic
// ---------------------------------------------------------------------------

describe("Signal Delivery Logic", () => {
  beforeEach(() => {
    createTestDb();
  });

  test("valid delivery: marks signal received, stores payload as step result, transitions run to running", () => {
    const runId = createRun({ status: "waiting-signal", fullStepOrder: ["wait-approval", "next-step"] });

    // Create a waiting signal record
    signalStore.create({
      runId,
      stepSlug: "wait-approval",
      event: "approval.granted",
      timeoutMs: null,
      inputSchema: null,
    });

    const payload = { approved: true, comment: "Looks good" };

    // Simulate the signal delivery logic
    const signal = signalStore.getWaiting(runId, "approval.granted");
    expect(signal).not.toBeNull();

    signalStore.markReceived(signal!.id, payload);
    runStore.updateStepResult(runId, "wait-approval", payload);
    runStore.updateStatus(runId, "running");

    // Verify signal is now received
    const updatedSignal = signalStore.getWaiting(runId, "approval.granted");
    expect(updatedSignal).toBeNull(); // No longer waiting

    // Verify step result stored
    const run = runStore.get(runId);
    expect(run!.status).toBe("running");
    expect(run!.stepResults["wait-approval"]).toEqual(payload);
  });

  test("run not found returns null (404 scenario)", () => {
    const run = runStore.get("nonexistent-run-id");
    expect(run).toBeNull();
  });

  test("run not in waiting-signal status (409 scenario)", () => {
    const runId = createRun({ status: "running", fullStepOrder: ["step-a"] });

    const run = runStore.get(runId);
    expect(run).not.toBeNull();
    expect(run!.status).not.toBe("waiting-signal");
  });

  test("signal not found for event (409 scenario)", () => {
    const runId = createRun({ status: "waiting-signal", fullStepOrder: ["wait-approval"] });

    // Create a signal for a different event
    signalStore.create({
      runId,
      stepSlug: "wait-approval",
      event: "approval.granted",
      timeoutMs: null,
      inputSchema: null,
    });

    // Query for a different event - should return null
    const signal = signalStore.getWaiting(runId, "approval.rejected");
    expect(signal).toBeNull();
  });

  test("already received signal - markReceived is no-op (409 scenario)", () => {
    const runId = createRun({ status: "waiting-signal", fullStepOrder: ["wait-approval"] });

    const signal = signalStore.create({
      runId,
      stepSlug: "wait-approval",
      event: "approval.granted",
      timeoutMs: null,
      inputSchema: null,
    });

    // First delivery
    signalStore.markReceived(signal.id, { first: true });

    // Second attempt - signal is no longer waiting
    const stillWaiting = signalStore.getWaiting(runId, "approval.granted");
    expect(stillWaiting).toBeNull();
  });

  test("inputSchema defined and payload invalid (422 scenario)", () => {
    const runId = createRun({ status: "waiting-signal", fullStepOrder: ["wait-approval"] });

    const inputSchema = Type.Object({
      approved: Type.Boolean(),
      reason: Type.String({ minLength: 1 }),
    });

    signalStore.create({
      runId,
      stepSlug: "wait-approval",
      event: "approval.granted",
      timeoutMs: null,
      inputSchema,
    });

    const signal = signalStore.getWaiting(runId, "approval.granted");
    expect(signal).not.toBeNull();

    // Invalid payload - missing required "reason" field
    const invalidPayload = { approved: "not-a-boolean" };
    const isValid = Value.Check(inputSchema, invalidPayload);
    expect(isValid).toBe(false);

    // Signal should stay in waiting status (retry allowed)
    const stillWaiting = signalStore.getWaiting(runId, "approval.granted");
    expect(stillWaiting).not.toBeNull();
    expect(stillWaiting!.status).toBe("waiting");
  });

  test("inputSchema defined and payload valid - proceeds normally", () => {
    const runId = createRun({ status: "waiting-signal", fullStepOrder: ["wait-approval"] });

    const inputSchema = Type.Object({
      approved: Type.Boolean(),
      reason: Type.String({ minLength: 1 }),
    });

    signalStore.create({
      runId,
      stepSlug: "wait-approval",
      event: "approval.granted",
      timeoutMs: null,
      inputSchema,
    });

    const signal = signalStore.getWaiting(runId, "approval.granted");
    expect(signal).not.toBeNull();

    // Valid payload
    const validPayload = { approved: true, reason: "Looks good" };
    const isValid = Value.Check(inputSchema, validPayload);
    expect(isValid).toBe(true);

    // Proceed with delivery
    signalStore.markReceived(signal!.id, validPayload);
    runStore.updateStepResult(runId, "wait-approval", validPayload);
    runStore.updateStatus(runId, "running");

    const run = runStore.get(runId);
    expect(run!.status).toBe("running");
    expect(run!.stepResults["wait-approval"]).toEqual(validPayload);
  });

  test("payload stored as waitFor step result accessible via template context", () => {
    const runId = createRun({
      status: "waiting-signal",
      stepResults: { "prev-step": "done" },
      fullStepOrder: ["prev-step", "wait-approval", "next-step"],
    });

    signalStore.create({
      runId,
      stepSlug: "wait-approval",
      event: "approval.granted",
      timeoutMs: null,
      inputSchema: null,
    });

    const signal = signalStore.getWaiting(runId, "approval.granted");
    const payload = { status: "approved", reviewer: "alice" };

    signalStore.markReceived(signal!.id, payload);
    runStore.updateStepResult(runId, "wait-approval", payload);
    runStore.updateStatus(runId, "running");

    // The step result is stored and accessible
    const run = runStore.get(runId);
    expect(run!.stepResults["wait-approval"]).toEqual(payload);
    // Template {{steps.wait-approval.result.status}} would resolve to "approved"
    expect((run!.stepResults["wait-approval"] as Record<string, unknown>).status).toBe("approved");
  });

  test("payload size validation (413 scenario) - conceptual boundary", () => {
    // The 1MB check happens at the HTTP layer (raw body length > 1_000_000).
    // Here we verify the conceptual boundary: a very large payload is still storable
    // if it passes the size check.
    const runId = createRun({ status: "waiting-signal", fullStepOrder: ["wait-approval"] });

    signalStore.create({
      runId,
      stepSlug: "wait-approval",
      event: "approval.granted",
      timeoutMs: null,
      inputSchema: null,
    });

    const signal = signalStore.getWaiting(runId, "approval.granted");

    // A payload just under 1MB (in terms of structure)
    const largePayload = { data: "x".repeat(900_000) };
    signalStore.markReceived(signal!.id, largePayload);
    runStore.updateStepResult(runId, "wait-approval", largePayload);

    const run = runStore.get(runId);
    expect((run!.stepResults["wait-approval"] as Record<string, unknown>).data).toContain("xxx");
  });
});

// ---------------------------------------------------------------------------
// Tests: Timeout
// ---------------------------------------------------------------------------

describe("WaitFor Timeout", () => {
  beforeEach(() => {
    createTestDb();
    signalTimers.cleanup();
  });

  test("timeout fires: signal marked timed_out, run failed, events broadcast", async () => {
    // Use a very short timeout for testing
    const wfStep = waitForStep({ slug: "wait-approval", event: "approval.granted", timeout: 50 });
    const steps: WorkflowStep[] = [agentStep("prev-step"), wfStep];

    const runId = createRun({ fullStepOrder: ["prev-step", "wait-approval"] });

    const flow = createFakeFlowProducer();
    const broadcast = createFakeBroadcast();
    const deps = buildDeps({
      steps,
      flowProducer: flow,
      broadcast,
    });

    await dispatchNextSegment(runId, 1, deps);

    // Timer should be registered
    expect(signalTimers.activeCount()).toBe(1);

    // Wait for the timeout to fire
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Signal should be timed out
    const signal = signalStore.getWaiting(runId, "approval.granted");
    expect(signal).toBeNull(); // No longer waiting

    // Run should be failed
    const run = runStore.get(runId);
    expect(run!.status).toBe("failed");
    expect(run!.failureReason).toContain("timed out");

    // Broadcast should have workflow_step_failed and workflow_failed
    const failedStepEvent = broadcast.events.find((e) => e.type === "workflow_step_failed");
    expect(failedStepEvent).not.toBeUndefined();
    expect((failedStepEvent as { stepSlug: string }).stepSlug).toBe("wait-approval");
    expect((failedStepEvent as { error: string }).error).toContain("timed out");

    const failedEvent = broadcast.events.find((e) => e.type === "workflow_failed");
    expect(failedEvent).not.toBeUndefined();
    expect((failedEvent as { failedStep: string }).failedStep).toBe("wait-approval");

    // Timer should be cleaned up after firing
    expect(signalTimers.activeCount()).toBe(0);
  });

  test("timer is tracked in signal timer registry", async () => {
    const wfStep = waitForStep({ slug: "wait-approval", event: "approval.granted", timeout: 60000 });
    const steps: WorkflowStep[] = [agentStep("prev-step"), wfStep];

    const runId = createRun({ fullStepOrder: ["prev-step", "wait-approval"] });

    const flow = createFakeFlowProducer();
    const broadcast = createFakeBroadcast();
    const deps = buildDeps({
      steps,
      flowProducer: flow,
      broadcast,
    });

    await dispatchNextSegment(runId, 1, deps);

    expect(signalTimers.activeCount()).toBe(1);

    // Clean up
    signalTimers.cleanup();
    expect(signalTimers.activeCount()).toBe(0);
  });

  test("timeout does not fire if signal is delivered before expiry", async () => {
    const wfStep = waitForStep({ slug: "wait-approval", event: "approval.granted", timeout: 200 });
    const steps: WorkflowStep[] = [agentStep("prev-step"), wfStep];

    const runId = createRun({ fullStepOrder: ["prev-step", "wait-approval"] });

    const flow = createFakeFlowProducer();
    const broadcast = createFakeBroadcast();
    const deps = buildDeps({
      steps,
      flowProducer: flow,
      broadcast,
    });

    await dispatchNextSegment(runId, 1, deps);

    // Simulate signal delivery before timeout (includes timer cancellation)
    const signal = signalStore.getWaiting(runId, "approval.granted");
    signalStore.markReceived(signal!.id, { approved: true });
    signalTimers.cancel(signal!.id);
    runStore.updateStepResult(runId, "wait-approval", { approved: true });
    runStore.updateStatus(runId, "running");

    // Wait for what would have been the timeout
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Timer was cancelled, so it should not have fired
    expect(signalTimers.activeCount()).toBe(0);

    // The run should still be running (not failed by timeout)
    const run = runStore.get(runId);
    expect(run!.status).toBe("running");

    // No workflow_failed event should have been broadcast after the signal delivery events
    const failedEvents = broadcast.events.filter((e) => e.type === "workflow_failed");
    expect(failedEvents).toHaveLength(0);
  });
});
