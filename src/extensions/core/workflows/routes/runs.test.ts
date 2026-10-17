import { beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionContext, Logger, ManagedQueuePort, RouteHandler } from "@ext/types";
import type { ResolvedPrincipal } from "@src/auth";
import { buildAbility } from "@src/auth";
import { createTestDb } from "@src/test/db";
import { setPrincipal } from "@src/web/auth";
import type { Context } from "elysia";
import type { DagStepJobData } from "../dagEngine";
import * as dagRunStore from "../dagRunStore";
import { initSignalStore } from "../signalStore";
import { registerRunsRoutes } from "./runs";
import type { WorkflowRouteDeps } from "./types";

/** Registers the run routes against a capturing ctx and returns the run-detail handler. */
function runDetailHandler(): RouteHandler {
  const handlers = new Map<string, RouteHandler>();
  const ctx = {
    routes: { register: (method: string, path: string, h: RouteHandler) => handlers.set(`${method} ${path}`, h) },
  } as unknown as ExtensionContext;
  const deps = {
    ctx,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger,
    store: new Map(),
    stepsQueue: { getAllJobs: async () => [] } as unknown as ManagedQueuePort<DagStepJobData>,
    hitl: undefined,
  } as unknown as WorkflowRouteDeps;
  registerRunsRoutes(deps);
  const handler = handlers.get("GET /runs/:runId");
  if (!handler) throw new Error("run detail route not registered");
  return handler;
}

function call(handler: RouteHandler, runId: string, query = "", userId = "owner"): Promise<Response> {
  const request = new Request(`http://localhost/ext/workflows/runs/${runId}${query}`);
  const principal: ResolvedPrincipal = {
    user: { id: userId, username: userId, roles: [], kind: "operator" },
    isAdmin: false,
    permissions: [],
    ability: buildAbility({ userId, isAdmin: false, permissions: [] }),
  };
  setPrincipal(request, principal);
  return Promise.resolve(handler({ request, params: { runId } } as unknown as Context));
}

beforeEach(() => {
  const db = createTestDb();
  dagRunStore.initDagRunStore(db);
  initSignalStore(db);
  dagRunStore.create({
    id: "run-1",
    workflowName: "wf",
    status: "failed",
    edgeStates: {},
    stepStatuses: { a: "completed", b: "failed" },
    stepResults: { a: { text: "hello" } },
    triggerPayload: null,
    failureReason: "b exploded",
    createdByUserId: "owner",
  });
  dagRunStore.create({
    id: "run-system",
    workflowName: "wf",
    status: "completed",
    edgeStates: {},
    stepStatuses: { a: "completed" },
    stepResults: { a: "system output" },
    triggerPayload: null,
    failureReason: null,
  });
});

describe("GET /runs/:runId", () => {
  test("omits step results by default", async () => {
    const body = (await (await call(runDetailHandler(), "run-1")).json()) as {
      failureReason: string;
      steps: Record<string, unknown>[];
    };
    expect(body.failureReason).toBe("b exploded");
    expect(body.steps.every((s) => !("result" in s))).toBe(true);
  });

  test("adds persisted step results with include=results for the run's starter", async () => {
    const body = (await (await call(runDetailHandler(), "run-1", "?include=results")).json()) as {
      steps: { slug: string; result?: unknown }[];
    };
    const bySlug = Object.fromEntries(body.steps.map((s) => [s.slug, s]));
    expect(bySlug.a?.result).toEqual({ text: "hello" });
    expect(bySlug.b && "result" in bySlug.b).toBe(false);
  });

  test("withholds results from other users", async () => {
    const body = (await (await call(runDetailHandler(), "run-1", "?include=results", "someone-else")).json()) as {
      steps: Record<string, unknown>[];
    };
    expect(body.steps.every((s) => !("result" in s))).toBe(true);
  });

  test("withholds results of runs without a recorded starter", async () => {
    const body = (await (await call(runDetailHandler(), "run-system", "?include=results")).json()) as {
      steps: Record<string, unknown>[];
    };
    expect(body.steps.every((s) => !("result" in s))).toBe(true);
  });

  test("answers 404 for an unknown run", async () => {
    expect((await call(runDetailHandler(), "nope")).status).toBe(404);
  });
});
