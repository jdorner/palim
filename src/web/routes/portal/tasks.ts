/**
 * Portal human task routes.
 *
 * Handles:
 * - `GET   /api/portal/tasks` - list tasks (`scope=mine|completed|all`, `status`, `limit`, `cursor`)
 * - `GET   /api/portal/tasks/counts` - badge counts (open, due soon)
 * - `GET   /api/portal/tasks/:id` - task detail with history (records the first view)
 * - `POST  /api/portal/tasks/:id/complete` - answer a task
 * - `POST  /api/portal/tasks/:id/cancel` - cancel a task (`hitl:manage`)
 * - `PATCH /api/portal/tasks/:id/assignees` - reassign a task (`hitl:manage`)
 *
 * Coarse access (`hitl:respond` / `hitl:manage`) is enforced by the central
 * authorization table; visibility of individual tasks by the HITL service,
 * which answers 404 for tasks the caller may not see.
 *
 * @module
 */

import { HUMAN_TASK_STATUSES, type HumanTaskStatus } from "@shared/portal";
import { Type } from "@sinclair/typebox";
import { HitlError, type HitlService } from "@src/hitl";
import { mainLogger as log } from "@src/utils/logger";
import { Elysia } from "elysia";
import { getPrincipal } from "../../auth";
import { hitlViewerFor } from "../../portalEvents";

/** Maps a thrown error to a response; HITL errors keep their status. */
function errorResponse(err: unknown, status: (code: number, body: unknown) => unknown) {
  if (err instanceof HitlError) {
    return status(err.status, { error: err.message, ...(err.details ? { details: err.details } : {}) });
  }
  log.error("Portal task route failed:", err);
  return status(500, { error: "Internal error" });
}

/**
 * Creates the portal task routes.
 *
 * @param getService - Getter for the HITL service (undefined during startup)
 * @returns Elysia plugin
 */
export function portalTaskRoutes(getService: () => HitlService | undefined) {
  return new Elysia()
    .get(
      "/api/portal/tasks",
      ({ query, request, status }) => {
        const service = getService();
        const principal = getPrincipal(request);
        if (!service) return status(503, { error: "Human tasks unavailable" });
        if (!principal) return status(401, { error: "Unauthorized" });
        if (query.status && !HUMAN_TASK_STATUSES.includes(query.status as HumanTaskStatus)) {
          return status(400, { error: `Invalid status "${query.status}"` });
        }
        try {
          return status(
            200,
            service.listTasks(hitlViewerFor(principal), {
              scope: query.scope,
              status: query.status as HumanTaskStatus | undefined,
              limit: query.limit,
              cursor: query.cursor,
            }),
          );
        } catch (err) {
          return errorResponse(err, status as never);
        }
      },
      {
        query: Type.Object({
          scope: Type.Optional(Type.Union([Type.Literal("mine"), Type.Literal("completed"), Type.Literal("all")])),
          status: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
          cursor: Type.Optional(Type.String({ maxLength: 128 })),
        }),
      },
    )
    .get("/api/portal/tasks/counts", ({ request, status }) => {
      const service = getService();
      const principal = getPrincipal(request);
      if (!service) return status(503, { error: "Human tasks unavailable" });
      if (!principal) return status(401, { error: "Unauthorized" });
      return status(200, service.countTasks(hitlViewerFor(principal)));
    })
    .get(
      "/api/portal/tasks/:id",
      ({ params, request, status }) => {
        const service = getService();
        const principal = getPrincipal(request);
        if (!service) return status(503, { error: "Human tasks unavailable" });
        if (!principal) return status(401, { error: "Unauthorized" });
        try {
          return status(200, { task: service.getTask(params.id, hitlViewerFor(principal)) });
        } catch (err) {
          return errorResponse(err, status as never);
        }
      },
      { params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) }) },
    )
    .post(
      "/api/portal/tasks/:id/complete",
      async ({ params, body, request, status }) => {
        const service = getService();
        const principal = getPrincipal(request);
        if (!service) return status(503, { error: "Human tasks unavailable" });
        if (!principal) return status(401, { error: "Unauthorized" });
        try {
          const task = await service.completeTask(params.id, hitlViewerFor(principal), body);
          return status(200, { task });
        } catch (err) {
          return errorResponse(err, status as never);
        }
      },
      {
        params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) }),
        body: Type.Object({
          outcome: Type.String({ minLength: 1, maxLength: 64 }),
          data: Type.Optional(Type.Unknown()),
          comment: Type.Optional(Type.Union([Type.String({ maxLength: 10_000 }), Type.Null()])),
          version: Type.Optional(Type.Integer({ minimum: 1 })),
        }),
      },
    )
    .post(
      "/api/portal/tasks/:id/cancel",
      async ({ params, body, request, status }) => {
        const service = getService();
        const principal = getPrincipal(request);
        if (!service) return status(503, { error: "Human tasks unavailable" });
        if (!principal) return status(401, { error: "Unauthorized" });
        try {
          const reason = body?.reason?.trim() || null;
          const task = await service.cancelTask(params.id, hitlViewerFor(principal), reason);
          return status(200, { task });
        } catch (err) {
          return errorResponse(err, status as never);
        }
      },
      {
        params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) }),
        body: Type.Optional(Type.Object({ reason: Type.Optional(Type.String({ maxLength: 1000 })) })),
      },
    )
    .patch(
      "/api/portal/tasks/:id/assignees",
      ({ params, body, request, status }) => {
        const service = getService();
        const principal = getPrincipal(request);
        if (!service) return status(503, { error: "Human tasks unavailable" });
        if (!principal) return status(401, { error: "Unauthorized" });
        try {
          return status(200, { task: service.reassignTask(params.id, hitlViewerFor(principal), body) });
        } catch (err) {
          return errorResponse(err, status as never);
        }
      },
      {
        params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) }),
        body: Type.Object({
          users: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 50 })),
          roles: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 50 })),
        }),
      },
    );
}
