/**
 * Job management routes - cancel jobs, fetch logs, and clean queues.
 *
 * Handles:
 * - `POST   /api/jobs/:jobId/cancel` - stop a job; it ends failed and stays listed
 * - `DELETE /api/jobs/:jobId`        - remove a finished job and its logs
 * - `GET    /api/jobs/:jobId/logs`
 * - `POST   /api/jobs/:jobId/retry`  - retry a failed job (not a workflow step: re-run its run)
 * - `POST   /api/queues/clean`
 *
 * Per-job routes treat other users' chat jobs as nonexistent (404), matching
 * their visibility in the WebSocket job feed.
 */

import { cancelReason } from "@shared/jobs";
import { Type } from "@sinclair/typebox";
import { mainLogger as log } from "@src/utils/logger";
import { Elysia } from "elysia";
import { getPrincipal } from "../auth";
import type { QueueMonitor } from "../monitor";

/**
 * Creates the job management route group.
 *
 * @param monitor - The queue monitor that tracks all managed queues
 * @returns Elysia plugin with job routes
 */
export function jobRoutes(monitor: QueueMonitor) {
  return new Elysia()
    .post(
      "/api/queues/clean",
      async ({ body, status }) => {
        try {
          const { grace, limit, type } = body;
          const allRemoved = await monitor.cleanAllQueues(grace, limit, type);

          log.info(`Queue cleanup completed (removed: ${allRemoved.length}, type: ${type ?? "completed"})`);
          return status(200, { removed: allRemoved.length, jobIds: allRemoved });
        } catch (error) {
          log.error("Failed to clean queues", { error });
          return status(500, { error: "Failed to clean queues" });
        }
      },
      {
        body: Type.Object({
          grace: Type.Number({ minimum: 0, description: "Minimum age in ms before a job can be cleaned" }),
          limit: Type.Number({ minimum: 1, description: "Maximum number of jobs to clean" }),
          type: Type.Optional(
            Type.Union(
              [Type.Literal("completed"), Type.Literal("failed"), Type.Literal("waiting"), Type.Literal("delayed")],
              {
                description: "Job state to clean (default: completed)",
              },
            ),
          ),
        }),
      },
    )
    .post(
      "/api/jobs/:jobId/cancel",
      async ({ params, request, status }) => {
        try {
          const { jobId } = params;
          if (!(await monitor.canAccessJob(jobId, getPrincipal(request)))) {
            return status(404, { error: `Job ${jobId} not found` });
          }
          const user = getPrincipal(request)?.user.username;
          const outcome = await monitor.cancelJob(jobId, cancelReason(user ? { user } : undefined));
          if (outcome === "not_found") return status(404, { error: `Job ${jobId} not found` });
          if (outcome === "finished") return status(409, { error: `Job ${jobId} has already finished` });
          if (outcome === "not_cancellable") return status(409, { error: `Job ${jobId} cannot be cancelled` });

          log.info("Job cancelled", { jobId });
          return status(200, { jobId, cancelled: true });
        } catch (error) {
          log.error("Failed to cancel job", { error });
          return status(500, { error: "Failed to cancel job" });
        }
      },
      {
        params: Type.Object({
          jobId: Type.String({ minLength: 1, description: "ID of the job to cancel" }),
        }),
      },
    )
    .delete(
      "/api/jobs/:jobId",
      async ({ params, request, status }) => {
        try {
          const { jobId } = params;
          if (!(await monitor.canAccessJob(jobId, getPrincipal(request)))) {
            return status(404, { error: `Job ${jobId} not found` });
          }
          const outcome = await monitor.deleteJob(jobId);
          if (outcome === "not_found") return status(404, { error: `Job ${jobId} not found` });
          if (outcome === "not_finished") {
            return status(409, { error: `Job ${jobId} has not finished; cancel it first` });
          }
          if (outcome === "workflow_step") {
            return status(409, { error: `Job ${jobId} is a workflow step; delete its workflow run instead` });
          }

          log.info("Job deleted", { jobId });
          return status(200, { jobId, deleted: true });
        } catch (error) {
          log.error("Failed to delete job", { error });
          return status(500, { error: "Failed to delete job" });
        }
      },
      {
        params: Type.Object({
          jobId: Type.String({ minLength: 1, description: "ID of the finished job to delete" }),
        }),
      },
    )
    .get(
      "/api/jobs/:jobId/logs",
      async ({ params, request, status }) => {
        try {
          const { jobId } = params;
          if (!(await monitor.canAccessJob(jobId, getPrincipal(request)))) {
            return status(404, { error: `Job ${jobId} not found` });
          }
          const logs = await monitor.getJobLogs(jobId);
          if (!logs) return status(404, { error: `Job ${jobId} not found` });

          return status(200, { logs: logs.logs, count: logs.count });
        } catch (error) {
          log.error("Failed to fetch job logs", { error });
          return status(500, { error: "Failed to fetch job logs" });
        }
      },
      {
        params: Type.Object({
          jobId: Type.String({ minLength: 1, description: "ID of the job to fetch logs for" }),
        }),
      },
    )
    .post(
      "/api/jobs/:jobId/retry",
      async ({ params, request, status }) => {
        try {
          const { jobId } = params;
          if (!(await monitor.canAccessJob(jobId, getPrincipal(request)))) {
            return status(404, { error: `Job ${jobId} not found` });
          }
          const outcome = await monitor.retryJob(jobId);
          if (outcome === "not_found") return status(404, { error: `Job ${jobId} not found` });
          if (outcome === "not_failed") return status(409, { error: "Only failed jobs can be retried" });
          if (outcome === "workflow_step") {
            return status(409, { error: `Job ${jobId} is a workflow step; re-run its workflow run instead` });
          }

          log.info("Job retried", { jobId });
          return status(200, { jobId, retried: true });
        } catch (error) {
          log.error("Failed to retry job", { error });
          return status(500, { error: "Failed to retry job" });
        }
      },
      {
        params: Type.Object({
          jobId: Type.String({ minLength: 1, description: "ID of the job to retry" }),
        }),
      },
    );
}
