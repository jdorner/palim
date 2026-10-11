/**
 * Signal delivery routes: resume a waiting `waitFor` step by signal ID or
 * by run and step.
 *
 * @module
 */

import * as dagRunStore from "../dagRunStore";
import { deliverSignal } from "../signalDelivery";
import * as signalStore from "../signalStore";
import type { WorkflowRouteDeps } from "./types";

/**
 * Registers the signal delivery routes.
 *
 * @param deps - Shared extension state and services
 */
export function registerSignalsRoutes(deps: WorkflowRouteDeps): void {
  const { ctx, coordinatorDeps } = deps;

  /**
   * Reads and parses a signal payload body. An empty body is `null`.
   *
   * @returns The payload, or an error response for oversized or invalid JSON
   */
  async function readSignalPayload(request: Request): Promise<{ payload: unknown } | { error: Response }> {
    const rawBody = await request.text();
    if (rawBody.length > 1_000_000) {
      return { error: Response.json({ error: "Payload too large" }, { status: 413 }) };
    }
    if (rawBody.length === 0) return { payload: null };
    try {
      return { payload: JSON.parse(rawBody) };
    } catch {
      return { error: Response.json({ error: "Invalid JSON payload" }, { status: 400 }) };
    }
  }

  /**
   * Delivers a payload to one signal through the shared delivery path and
   * maps the result to an HTTP response.
   */
  function deliverAndRespond(signalId: string, payload: unknown): Response {
    const result = deliverSignal(signalId, payload, { via: "route", coordinatorDeps });
    if (!result.ok) {
      return Response.json(
        { error: result.error, ...(result.details ? { details: result.details } : {}) },
        { status: result.status },
      );
    }
    const { signal } = result;
    return Response.json({
      accepted: true,
      runId: signal.runId,
      stepSlug: signal.stepSlug,
      signalId: signal.id,
      event: signal.event,
    });
  }

  /**
   * Signal delivery by signal ID - resumes exactly one waiting step.
   */
  ctx.routes.register(
    "POST",
    "/signals/:signalId",
    async (reqCtx) => {
      const signalId = (reqCtx.params as Record<string, string>).signalId;
      if (!signalId) return Response.json({ error: "Missing signalId" }, { status: 400 });

      const body = await readSignalPayload(reqCtx.request);
      if ("error" in body) return body.error;

      return deliverAndRespond(signalId, body.payload);
    },
    { parse: "none" },
  );

  /**
   * Signal delivery by run and step - resumes the named waiting step of one run.
   */
  ctx.routes.register(
    "POST",
    "/runs/:runId/steps/:slug/signal",
    async (reqCtx) => {
      const { runId, slug } = reqCtx.params as Record<string, string>;
      if (!runId || !slug) return Response.json({ error: "Missing runId or step slug" }, { status: 400 });

      const body = await readSignalPayload(reqCtx.request);
      if ("error" in body) return body.error;

      if (!dagRunStore.get(runId)) {
        return Response.json({ error: "Run not found" }, { status: 404 });
      }
      const signal = signalStore.getWaitingForStep(runId, slug);
      if (!signal) {
        return Response.json({ error: `Step "${slug}" is not awaiting a signal` }, { status: 409 });
      }

      return deliverAndRespond(signal.id, body.payload);
    },
    { parse: "none" },
  );
}
