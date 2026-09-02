/**
 * Tests for the DAG step worker's template-resolution contract.
 *
 * Regression coverage for a double-resolution bug: the worker used to
 * pre-resolve every string field of a custom step's definition before calling
 * the handler. That defeated handlers (notably sandbox-exec) that rely on
 * receiving RAW `{{...}}` expressions so they can bind each expression safely
 * (e.g. to a shell env var) instead of having a resolved value spliced inline.
 *
 * The worker now passes the raw step definition through; handlers resolve the
 * fields they consume themselves via `ctx.resolveTemplate`.
 *
 * Uses in-memory SQLite for the run store, per project testing conventions.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { StepExecutionContext, StepTypeHandler } from "@ext/types";
import { Type } from "@sinclair/typebox";
import { createTestDb } from "@src/test/db";
import type { DagStepJobData } from "./dagEngine";
import * as dagRunStore from "./dagRunStore";
import { createDagStepProcessor, type DagStepWorkerDeps } from "./dagWorker";

const fakeLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as DagStepWorkerDeps["log"];

/** Minimal ExtensionContext stub exposing only what buildDagTemplateContext touches. */
function fakeCtx(): DagStepWorkerDeps["ctx"] {
  return {
    paths: { work: "/tmp/work" },
    internal: undefined,
    skills: { resolve: () => undefined, names: () => [] },
  } as unknown as DagStepWorkerDeps["ctx"];
}

/** A fake queue job carrying the given step definition. */
function fakeJob(stepDef: Record<string, unknown>, workflowRunId: string) {
  const data: DagStepJobData = {
    workflowRunId,
    workflowName: "test-wf",
    stepSlug: "probe-consumer",
    stepDef: stepDef as DagStepJobData["stepDef"],
    allStepDefs: { "probe-consumer": stepDef },
    sessionId: "sess-1",
  };
  return { id: "job-1", data, log: async () => {} } as unknown as Parameters<
    ReturnType<typeof createDagStepProcessor>
  >[0];
}

/** Seeds a run whose `probe` step result is a shell-hostile JSON string. */
function seedRunWithProbeResult(runId: string, probeResult: string): void {
  dagRunStore.create({
    id: runId,
    workflowName: "test-wf",
    status: "running",
    edgeStates: {},
    stepStatuses: {},
    stepResults: { probe: probeResult },
    triggerPayload: null,
    failureReason: null,
  });
}

beforeEach(() => {
  const db = createTestDb();
  dagRunStore.initDagRunStore(db);
});

describe("createDagStepProcessor - custom step template handling", () => {
  test("passes the RAW step definition to the handler (no pre-resolution)", async () => {
    const runId = "run-raw";
    // A JSON string exactly like what music-metadata returns: full of shell
    // metacharacters ({}, [], ", ,) that must NOT be spliced inline.
    const probeJson = JSON.stringify([
      { path: "./mp3/a.mp3", title: "A", track: 1 },
      { path: "./mp3/b.mp3", title: "B", track: 2 },
    ]);
    seedRunWithProbeResult(runId, probeJson);

    let receivedStepDef: Record<string, unknown> | undefined;
    let resolvedInsideHandler: string | undefined;

    const handler: StepTypeHandler = {
      schema: Type.Object({ command: Type.String() }),
      label: "Fake",
      async execute(stepDef, ctx: StepExecutionContext) {
        receivedStepDef = stepDef;
        // The handler resolves the field itself, as real handlers do.
        const { resolved } = await ctx.resolveTemplate(stepDef.command as string);
        resolvedInsideHandler = resolved;
        return { ok: true };
      },
    };

    const deps: DagStepWorkerDeps = {
      ctx: fakeCtx(),
      emitEvent: () => {},
      log: fakeLog,
      getStepHandler: () => handler,
    };

    const stepDef = {
      slug: "probe-consumer",
      type: "fake",
      command: "printf '%s' {{steps.probe.result}}",
    };

    const processor = createDagStepProcessor(deps);
    await processor(fakeJob(stepDef, runId));

    // The handler must see the RAW template, not a pre-resolved value.
    expect(receivedStepDef?.command).toBe("printf '%s' {{steps.probe.result}}");
    // And when IT resolves the field, it gets the intact JSON string.
    expect(resolvedInsideHandler).toBe(`printf '%s' ${probeJson}`);
  });

  test("does not mutate non-templated fields", async () => {
    const runId = "run-plain";
    seedRunWithProbeResult(runId, "irrelevant");

    let received: Record<string, unknown> | undefined;
    const handler: StepTypeHandler = {
      schema: Type.Object({}),
      label: "Fake",
      async execute(stepDef) {
        received = stepDef;
        return null;
      },
    };
    const deps: DagStepWorkerDeps = {
      ctx: fakeCtx(),
      emitEvent: () => {},
      log: fakeLog,
      getStepHandler: () => handler,
    };

    const stepDef = { slug: "probe-consumer", type: "fake", size: 200, plain: "no templates here" };
    const processor = createDagStepProcessor(deps);
    await processor(fakeJob(stepDef, runId));

    expect(received?.size).toBe(200);
    expect(received?.plain).toBe("no templates here");
  });

  test("returns the handler result value", async () => {
    const runId = "run-result";
    seedRunWithProbeResult(runId, "x");
    const handler: StepTypeHandler = {
      schema: Type.Object({}),
      label: "Fake",
      async execute() {
        return { computed: 42 };
      },
    };
    const deps: DagStepWorkerDeps = {
      ctx: fakeCtx(),
      emitEvent: () => {},
      log: fakeLog,
      getStepHandler: () => handler,
    };
    const processor = createDagStepProcessor(deps);
    const result = await processor(fakeJob({ slug: "probe-consumer", type: "fake" }, runId));
    expect(result).toEqual({ computed: 42 });
  });

  test("throws when no handler is registered for the step type", async () => {
    const runId = "run-nohandler";
    seedRunWithProbeResult(runId, "x");
    const deps: DagStepWorkerDeps = {
      ctx: fakeCtx(),
      emitEvent: () => {},
      log: fakeLog,
      getStepHandler: () => undefined,
    };
    const processor = createDagStepProcessor(deps);
    await expect(processor(fakeJob({ slug: "probe-consumer", type: "unknown" }, runId))).rejects.toThrow(
      'No handler registered for step type "unknown"',
    );
  });
});
