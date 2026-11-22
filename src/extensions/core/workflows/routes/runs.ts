/**
 * Workflow run routes: rerun, cancel, run list, run detail, step logs, delete.
 *
 * The routes parse requests and pick the requesting user; the run lifecycle
 * ({@link WorkflowRuns}) does the work.
 *
 * @module
 */

import type { CancelRunResult, RemoveRunResult, RerunResult } from "../workflowRuns";
import type { WorkflowRouteDeps } from "./types";

/** HTTP answers for rerun refusals. */
const RERUN_REFUSALS: Record<Extract<RerunResult, { ok: false }>["reason"], { error: string; status: number }> = {
  run_not_found: { error: "Run not found", status: 404 },
  not_failed: { error: "Only failed runs can be re-run", status: 409 },
  workflow_not_found: { error: "Workflow not found", status: 404 },
};

/** HTTP answers for cancel refusals. */
const CANCEL_REFUSALS: Record<Extract<CancelRunResult, { ok: false }>["reason"], { error: string; status: number }> = {
  run_not_found: { error: "Run not found", status: 404 },
  not_active: { error: "Only running or waiting runs can be cancelled", status: 409 },
};

/** HTTP answers for delete refusals. */
const REMOVE_REFUSALS: Record<Extract<RemoveRunResult, { ok: false }>["reason"], { error: string; status: number }> = {
  run_not_found: { error: "Run not found", status: 404 },
  not_finished: { error: "Only completed or failed runs can be deleted; cancel the run first", status: 409 },
  jobs_live: {
    error: "Some of the run's jobs are still queued or running; try again once they have ended",
    status: 409,
  },
};

/**
 * Registers the run routes (`/runs`, `/runs/:runId/*`).
 *
 * @param deps - Shared extension state and services
 */
export function registerRunsRoutes(deps: WorkflowRouteDeps): void {
  const { ctx, runs } = deps;

  // Starts a fresh run of a failed run's workflow with the same trigger
  // payload. The original run is left untouched (it stays failed).
  ctx.routes.register("POST", "/runs/:runId/rerun", async (reqCtx) => {
    const runId = (reqCtx.params as Record<string, string>).runId;
    if (!runId) return Response.json({ error: "Missing runId" }, { status: 400 });
    const result = await runs.rerun(runId, ctx.auth.requestUserId(reqCtx.request));
    if (!result.ok) {
      const { error, status } = RERUN_REFUSALS[result.reason];
      return Response.json({ error }, { status });
    }
    return Response.json({ ok: true, workflowRunId: result.workflowRunId, jobIds: result.jobIds }, { status: 202 });
  });

  // Cancels an active run: it ends failed ("Cancelled by <user>") and stays
  // listed with its jobs until it is deleted.
  ctx.routes.register("POST", "/runs/:runId/cancel", async (reqCtx) => {
    const runId = (reqCtx.params as Record<string, string>).runId;
    if (!runId) return Response.json({ error: "Missing runId" }, { status: 400 });
    const result = await runs.cancel(runId, ctx.auth.requestUsername(reqCtx.request));
    if (!result.ok) {
      const { error, status } = CANCEL_REFUSALS[result.reason];
      return Response.json({ error }, { status });
    }
    return Response.json({ runId, cancelled: true });
  });

  // Lightweight bulk run-status lookup. Returns one { runId, status }
  // entry per persisted run across ALL workflows in a single request, so
  // the job list can enrich workflow group badges without fanning out one
  // detail request per workflow definition (which previously tripped the
  // rate limiter after a few page loads).
  ctx.routes.register("GET", "/runs", async () => Response.json(runs.statuses()));

  ctx.routes.register("GET", "/runs/:runId", async (reqCtx) => {
    const runId = (reqCtx.params as Record<string, string>).runId;
    if (!runId) return Response.json({ error: "Missing runId" }, { status: 400 });
    // `?include=results` adds each step's persisted result (API clients such
    // as MCP servers); the run page does not need them. Only the run's
    // starter gets them; everyone else sees statuses only.
    const wantsResults = new URL(reqCtx.request.url).searchParams.get("include") === "results";
    const description = await runs.describe(runId, {
      resultsFor: wantsResults ? ctx.auth.requestUserId(reqCtx.request) : undefined,
    });
    if (!description) return Response.json({ error: "Run not found" }, { status: 404 });
    return Response.json(description);
  });

  ctx.routes.register("GET", "/runs/:runId/logs", async (reqCtx) => {
    const runId = (reqCtx.params as Record<string, string>).runId;
    if (!runId) return Response.json({ error: "Missing runId" }, { status: 400 });
    const logs = await runs.stepLogs(runId);
    if (!logs) return Response.json({ error: "Run not found" }, { status: 404 });
    return Response.json(logs);
  });

  ctx.routes.register("DELETE", "/runs/:runId", async (reqCtx) => {
    const runId = (reqCtx.params as Record<string, string>).runId;
    if (!runId) return Response.json({ error: "Missing runId" }, { status: 400 });
    const result = await runs.remove(runId);
    if (!result.ok) {
      const { error, status } = REMOVE_REFUSALS[result.reason];
      return Response.json({ error }, { status });
    }
    return Response.json({ runId, removed: result.removed, total: result.total });
  });
}
