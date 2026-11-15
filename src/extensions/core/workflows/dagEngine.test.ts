/**
 * Tests for the DAG step job builder. Starting runs is tested with the
 * coordinator (`startRun` in dagCoordinator.test.ts).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { createTestDb } from "@src/test/db";
import { buildDagStepJob } from "./dagEngine";
import * as dagRunStore from "./dagRunStore";

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

beforeEach(() => {
  const db = createTestDb();
  dagRunStore.initDagRunStore(db);
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
