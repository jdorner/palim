import { beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionContext, Logger, RouteHandler } from "@ext/types";
import type { ResolvedPrincipal } from "@src/auth";
import { buildAbility } from "@src/auth";
import { createTestDb } from "@src/test/db";
import { setPrincipal } from "@src/web/auth";
import { requestUserId, requestUsername } from "@src/web/triggerOwnership";
import type { Context } from "elysia";
import * as dagRunStore from "../dagRunStore";
import { initSignalStore } from "../signalStore";
import { createWorkflowRuns, type StepsQueue } from "../workflowRuns";
import { registerRunsRoutes } from "./runs";
import type { WorkflowRouteDeps } from "./types";

/** Registers the run routes against a capturing ctx and returns the handler of one route. */
function routeHandler(route: string): RouteHandler {
  const handlers = new Map<string, RouteHandler>();
  const ctx = {
    routes: { register: (method: string, path: string, h: RouteHandler) => handlers.set(`${method} ${path}`, h) },
    auth: { requestUserId, requestUsername },
  } as unknown as ExtensionContext;
  const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;
  const runs = createWorkflowRuns({
    stepsQueue: {
      getAllJobs: async () => [],
      onEvent() {},
      cancelJob: async () => "cancelled",
      removeJobs: async () => [],
    } as unknown as StepsQueue,
    flowProducer: {} as never,
    sessionFactory: {} as never,
    log,
    broadcast() {},
    emitEvent() {},
    getWorkflowDefinition: () => undefined,
    hitl: undefined,
  });
  const deps = { ctx, logger: log, store: new Map(), runs, hitlEnabled: false } as unknown as WorkflowRouteDeps;
  registerRunsRoutes(deps);
  const handler = handlers.get(route);
  if (!handler) throw new Error(`${route} not registered`);
  return handler;
}

/** The run-detail handler. */
const runDetailHandler = () => routeHandler("GET /runs/:runId");

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

describe("POST /runs/:runId/cancel", () => {
  test("fails an active run with the requesting user's name", async () => {
    dagRunStore.create({
      id: "run-active",
      workflowName: "wf",
      status: "running",
      edgeStates: {},
      stepStatuses: { a: "running" },
      stepResults: {},
      triggerPayload: null,
      failureReason: null,
    });
    const res = await call(routeHandler("POST /runs/:runId/cancel"), "run-active", "", "alice");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId: "run-active", cancelled: true });
    expect(dagRunStore.get("run-active")).toMatchObject({ status: "failed", failureReason: "Cancelled by alice" });
  });

  test("answers 409 for a finished run and 404 for an unknown one", async () => {
    const cancel = routeHandler("POST /runs/:runId/cancel");
    expect((await call(cancel, "run-1")).status).toBe(409);
    expect((await call(cancel, "nope")).status).toBe(404);
  });
});

describe("DELETE /runs/:runId", () => {
  test("deletes a finished run", async () => {
    const res = await call(routeHandler("DELETE /runs/:runId"), "run-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId: "run-1", removed: [], total: 0 });
    expect(dagRunStore.get("run-1")).toBeNull();
  });

  test("answers 409 for an active run and 404 for an unknown one", async () => {
    dagRunStore.create({
      id: "run-active",
      workflowName: "wf",
      status: "waiting-signal",
      edgeStates: {},
      stepStatuses: { w: "waiting-signal" },
      stepResults: {},
      triggerPayload: null,
      failureReason: null,
    });
    const remove = routeHandler("DELETE /runs/:runId");
    expect((await call(remove, "run-active")).status).toBe(409);
    expect(dagRunStore.get("run-active")).not.toBeNull();
    expect((await call(remove, "nope")).status).toBe(404);
  });
});
