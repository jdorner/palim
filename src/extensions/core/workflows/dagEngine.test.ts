/**
 * Tests for the DAG workflow engine dispatch.
 *
 * Uses in-memory SQLite for isolation. Validates root step identification,
 * parallel dispatch of multiple roots, and Run Store initialization.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { createTestDb } from "@src/test/db";
import { buildDagStepJob, buildIncomingEdgeMap, buildOutgoingEdgeMap, dispatchDagWorkflow } from "./dagEngine";
import * as dagRunStore from "./dagRunStore";
import type { DagWorkflowDefinition } from "./schemas";

/** Fake FlowProducer that records dispatched jobs. */
function createFakeFlow() {
  const dispatched: { name: string; data: unknown }[] = [];
  let jobCounter = 0;
  return {
    dispatched,
    flow: {
      add: async (job: { name: string; data: unknown }) => {
        dispatched.push(job);
        jobCounter++;
        return { job: { id: `job-${jobCounter}` } };
      },
      addChain: async () => ({ jobIds: [] }),
      getParentResult: async () => null,
    } as any,
  };
}

/** Fake session factory. */
function createFakeSessionFactory() {
  let counter = 0;
  return {
    create: () => {
      counter++;
      return { id: `session-${counter}` };
    },
  };
}

/** Fake logger. */
const fakeLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as any;

beforeEach(() => {
  const db = createTestDb();
  dagRunStore.initDagRunStore(db);
});

describe("dispatchDagWorkflow", () => {
  test("dispatches a single root step", async () => {
    const def: DagWorkflowDefinition = {
      name: "test-wf",
      trigger: { type: "manual" },
      steps: {
        a: { type: "agent", prompt: "do A" },
        b: { type: "agent", prompt: "do B" },
      },
      edges: [{ from: "a", to: "b" }],
    };

    const { flow, dispatched } = createFakeFlow();
    const result = await dispatchDagWorkflow(flow, def, null, fakeLog, createFakeSessionFactory());

    expect(result.jobIds).toEqual(["job-1"]);
    expect(dispatched.length).toBe(1);
    expect((dispatched[0]!.data as any).stepSlug).toBe("a");
  });

  test("dispatches multiple root steps in parallel", async () => {
    const def: DagWorkflowDefinition = {
      name: "test-wf",
      trigger: { type: "manual" },
      steps: {
        a: { type: "agent", prompt: "root 1" },
        b: { type: "agent", prompt: "root 2" },
        c: { type: "agent", prompt: "join" },
      },
      edges: [
        { from: "a", to: "c" },
        { from: "b", to: "c" },
      ],
    };

    const { flow, dispatched } = createFakeFlow();
    const result = await dispatchDagWorkflow(flow, def, { event: "test" }, fakeLog, createFakeSessionFactory());

    expect(result.jobIds.length).toBe(2);
    expect(dispatched.length).toBe(2);
    const slugs = dispatched.map((d) => (d.data as any).stepSlug).sort();
    expect(slugs).toEqual(["a", "b"]);
  });

  test("initializes Run Store with correct edge and step states", async () => {
    const def: DagWorkflowDefinition = {
      name: "test-wf",
      trigger: { type: "manual" },
      steps: {
        a: { type: "agent", prompt: "x" },
        b: { type: "agent", prompt: "y" },
        c: { type: "agent", prompt: "z" },
      },
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
      ],
    };

    const { flow } = createFakeFlow();
    const result = await dispatchDagWorkflow(flow, def, null, fakeLog, createFakeSessionFactory());

    const run = dagRunStore.get(result.workflowRunId);
    expect(run).not.toBeNull();
    expect(run!.status).toBe("running");
    // Edge states: a:b and a:c both initialized as pending
    expect(run!.edgeStates["a:b"]).toBe("pending");
    expect(run!.edgeStates["a:c"]).toBe("pending");
    // Root step status is "running" (dispatched), non-roots are "pending"
    expect(run!.stepStatuses.a).toBe("running");
    expect(run!.stepStatuses.b).toBe("pending");
    expect(run!.stepStatuses.c).toBe("pending");
  });

  test("does not dispatch CF root nodes as jobs", async () => {
    const def: DagWorkflowDefinition = {
      name: "test-wf",
      trigger: { type: "manual" },
      steps: {
        decide: { type: "if", condition: { ref: "{{trigger.payload.x}}", eq: "yes" } },
        a: { type: "agent", prompt: "then path" },
        b: { type: "agent", prompt: "else path" },
      },
      edges: [
        { from: "decide", to: "a", branch: "then" },
        { from: "decide", to: "b", branch: "else" },
      ],
    };

    const { flow, dispatched } = createFakeFlow();
    const result = await dispatchDagWorkflow(flow, def, null, fakeLog, createFakeSessionFactory());

    // CF root is not dispatched as a job
    expect(result.jobIds).toEqual([]);
    expect(dispatched.length).toBe(0);
  });

  test("persists trigger payload in Run Store", async () => {
    const def: DagWorkflowDefinition = {
      name: "test-wf",
      trigger: { type: "webhook" },
      steps: {
        a: { type: "agent", prompt: "x" },
        b: { type: "agent", prompt: "y" },
      },
      edges: [{ from: "a", to: "b" }],
    };

    const payload = { body: { id: 123, action: "create" } };
    const { flow } = createFakeFlow();
    const result = await dispatchDagWorkflow(flow, def, payload, fakeLog, createFakeSessionFactory());

    const run = dagRunStore.get(result.workflowRunId);
    expect(run!.triggerPayload).toEqual(payload);
  });
});

describe("buildDagStepJob", () => {
  test("creates a job with correct fields", () => {
    const job = buildDagStepJob("fetch", {
      workflowRunId: "run-1",
      workflowName: "my-wf",
      stepDef: { type: "agent", prompt: "do stuff" },
      allStepDefs: { fetch: { type: "agent", prompt: "do stuff" } },
      sessionFactory: createFakeSessionFactory(),
      triggerPayload: { key: "value" },
    });

    expect(job.data!.stepSlug).toBe("fetch");
    expect(job.data!.workflowRunId).toBe("run-1");
    expect(job.data!.workflowName).toBe("my-wf");
    expect(job.data!.triggerPayload).toEqual({ key: "value" });
    expect(job.data!.sessionId).toContain("session-");
    expect(job.queueName).toBe("workflows:steps");
    expect(job.name).toBe("fetch");
  });
});

describe("buildIncomingEdgeMap", () => {
  test("maps step slugs to incoming edge IDs", () => {
    const def: DagWorkflowDefinition = {
      name: "test",
      trigger: { type: "manual" },
      steps: {
        a: { type: "agent", prompt: "x" },
        b: { type: "agent", prompt: "y" },
        c: { type: "agent", prompt: "z" },
      },
      edges: [
        { from: "a", to: "c" },
        { from: "b", to: "c" },
      ],
    };

    const map = buildIncomingEdgeMap(def);
    expect(map.get("a")).toEqual([]);
    expect(map.get("b")).toEqual([]);
    expect(map.get("c")!.sort()).toEqual(["a:c", "b:c"]);
  });
});

describe("buildOutgoingEdgeMap", () => {
  test("maps step slugs to outgoing edges", () => {
    const def: DagWorkflowDefinition = {
      name: "test",
      trigger: { type: "manual" },
      steps: {
        a: { type: "agent", prompt: "x" },
        b: { type: "agent", prompt: "y" },
        c: { type: "agent", prompt: "z" },
      },
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
      ],
    };

    const map = buildOutgoingEdgeMap(def);
    expect(map.get("a")!.length).toBe(2);
    expect(map.get("b")).toEqual([]);
    expect(map.get("c")).toEqual([]);
  });
});
