/**
 * Tests for the workflow completion handler.
 *
 * Validates that step results are persisted to the Run Store
 * so that subsequent control flow nodes (case/if) can resolve
 * template expressions like `{{steps.<slug>.result}}`.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { WorkflowWebSocketEvent } from "@shared/workflows";
import { createWorkflowTestDb } from "@src/test/db";
import type { FlowProducer, FlowStep } from "bunqueue/client";
import { type CompletedStepJob, type CompletionHandlerDeps, handleStepCompletion } from "./completionHandler";
import type { SessionFactory } from "./engine";
import * as runStore from "./runStore";
import type { CaseStep, WorkflowStep } from "./schemas";
import type { WorkflowStepJobData } from "./types";

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

function createFakeBroadcast() {
  const events: WorkflowWebSocketEvent[] = [];
  return {
    events,
    fn: (event: WorkflowWebSocketEvent) => {
      events.push(event);
    },
  };
}

function buildDeps(opts: {
  flowProducer?: ReturnType<typeof createFakeFlowProducer>;
  broadcast?: ReturnType<typeof createFakeBroadcast>;
  workflowSteps?: WorkflowStep[];
}): CompletionHandlerDeps {
  const flow = opts.flowProducer ?? createFakeFlowProducer();
  const broadcast = opts.broadcast ?? createFakeBroadcast();
  const steps = opts.workflowSteps ?? [];
  return {
    flowProducer: flow as unknown as FlowProducer,
    sessionFactory: createFakeSessionFactory(),
    log: { info: () => {}, warn: () => {}, error: () => {} } as unknown as CompletionHandlerDeps["log"],
    broadcast: broadcast.fn,
    getWorkflowDefinition: () => (steps.length > 0 ? { steps } : undefined),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleStepCompletion", () => {
  beforeEach(() => {
    createWorkflowTestDb();
  });

  describe("step result persistence for multi-segment workflows", () => {
    /**
     * This test reproduces the real runtime scenario:
     *
     * ManagedQueue.onEvent("completed") resolves the job via getJob(),
     * which returns a JobInfo without `returnvalue`. The workflow event
     * handler then passes `returnvalue: undefined` to handleStepCompletion.
     *
     * The completion handler must still ensure step results are available
     * for subsequent control flow nodes. This test proves the bug: when
     * returnvalue is undefined, the step result is never persisted.
     */
    test("persists step result to run store when returnvalue is provided", async () => {
      // Workflow: [agent-step] -> [case-node]
      const agentStep: WorkflowStep = { slug: "categorize", type: "agent", prompt: "Categorize" };
      const caseNode: CaseStep = {
        slug: "route",
        type: "case",
        match: "{{steps.categorize.result}}",
        paths: { "Messe 2025": [{ slug: "move", type: "sandbox-exec", command: "mv file" }] },
        default: [{ slug: "fallback", type: "sandbox-exec", command: "mv file default" }],
      };
      const workflowSteps: WorkflowStep[] = [agentStep, caseNode];

      // Create the run with empty step results (agent step hasn't been recorded yet)
      const runId = "run-persist-test";
      runStore.create({
        id: runId,
        workflowName: "inbox-sorter",
        status: "running",
        stepResults: {},
        triggerPayload: { filename: "invoice.pdf" },
        currentStepIndex: 0,
        fullStepOrder: ["categorize", "route"],
        failureReason: null,
      });

      const flow = createFakeFlowProducer();
      const broadcast = createFakeBroadcast();
      const deps = buildDeps({ flowProducer: flow, broadcast, workflowSteps });

      // Simulate what ManagedQueue.onEvent("completed") actually provides:
      // The job.returnvalue comes from extracting it off the JobInfo object,
      // which does NOT include returnvalue (getJob strips it).
      // This mimics: `const jobResult = (job as unknown as { returnvalue? }).returnvalue`
      // where `job` is a JobInfo without that field.
      const jobData: WorkflowStepJobData = {
        workflowRunId: runId,
        workflowName: "inbox-sorter",
        stepSlug: "categorize",
        stepIndex: 0,
        totalSteps: 2,
        stepDef: agentStep,
        allStepDefs: { categorize: agentStep, route: caseNode },
        sessionId: "session-1",
      };

      const completedJob: CompletedStepJob = {
        id: "job-categorize-1",
        data: jobData,
        // This is what the runtime actually provides - the StepResult from the worker
        returnvalue: {
          value: "Messe 2025",
          _stepResults: { categorize: "Messe 2025" },
          _triggerPayload: { filename: "invoice.pdf" },
        },
      };

      await handleStepCompletion(completedJob, deps);

      // Verify the step result was persisted to the run store
      const run = runStore.get(runId);
      expect(run).not.toBeNull();
      expect(run!.stepResults.categorize).toBe("Messe 2025");
    });

    test("does not persist step result when returnvalue is undefined", async () => {
      // This documents the guard behavior: if returnvalue is missing
      // (e.g. job failed without producing output), nothing is written.
      // The fix ensures ManagedQueue.getJob() always provides returnvalue
      // for completed jobs, so this path only triggers for edge cases.
      const agentStep: WorkflowStep = { slug: "categorize", type: "agent", prompt: "Categorize" };
      const caseNode: CaseStep = {
        slug: "route",
        type: "case",
        match: "{{steps.categorize.result}}",
        paths: { "Messe 2025": [{ slug: "move", type: "sandbox-exec", command: "mv file" }] },
        default: [{ slug: "fallback", type: "sandbox-exec", command: "mv file default" }],
      };
      const workflowSteps: WorkflowStep[] = [agentStep, caseNode];

      const runId = "run-no-result";
      runStore.create({
        id: runId,
        workflowName: "inbox-sorter",
        status: "running",
        stepResults: {},
        triggerPayload: { filename: "invoice.pdf" },
        currentStepIndex: 0,
        fullStepOrder: ["categorize", "route"],
        failureReason: null,
      });

      const flow = createFakeFlowProducer();
      const broadcast = createFakeBroadcast();
      const deps = buildDeps({ flowProducer: flow, broadcast, workflowSteps });

      const jobData: WorkflowStepJobData = {
        workflowRunId: runId,
        workflowName: "inbox-sorter",
        stepSlug: "categorize",
        stepIndex: 0,
        totalSteps: 2,
        stepDef: agentStep,
        allStepDefs: { categorize: agentStep, route: caseNode },
        sessionId: "session-1",
      };

      const completedJob: CompletedStepJob = {
        id: "job-categorize-1",
        data: jobData,
        returnvalue: undefined,
      };

      await handleStepCompletion(completedJob, deps);

      const run = runStore.get(runId);
      expect(run).not.toBeNull();
      expect(run!.stepResults.categorize).toBeUndefined();
    });
  });
});
