/**
 * Job management routes - cancel jobs, fetch logs, and clean queues.
 *
 * Handles:
 * - `POST /api/jobs/:jobId/cancel`
 * - `GET  /api/jobs/:jobId/chain`
 * - `GET  /api/jobs/:jobId/logs`
 * - `POST /api/queues/clean`
 */

import { Type } from "@sinclair/typebox";
import { mainLogger as log } from "@src/utils/logger";
import { Elysia } from "elysia";
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
      async ({ params, status }) => {
        try {
          const { jobId } = params;
          const cancelled = await monitor.cancelJob(jobId);

          if (!cancelled) {
            return status(404, { error: `Job ${jobId} not found` });
          }

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
    .get(
      "/api/jobs/:jobId/chain",
      async ({ params, status }) => {
        try {
          const { jobId } = params;
          const result = await monitor.getChainSiblings(jobId);

          if (!result) {
            return status(404, { error: `Job ${jobId} is not part of a workflow chain` });
          }

          return status(200, {
            workflowRunId: result.workflowRunId,
            siblings: result.siblings,
          });
        } catch (error) {
          log.error("Failed to get chain siblings", { error });
          return status(500, { error: "Failed to get chain siblings" });
        }
      },
      {
        params: Type.Object({
          jobId: Type.String({ minLength: 1, description: "ID of any job in the chain" }),
        }),
      },
    )
    .get(
      "/api/jobs/:jobId/logs",
      async ({ params, status }) => {
        try {
          const { jobId } = params;
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
      async ({ params, status }) => {
        try {
          const { jobId } = params;
          const retried = await monitor.retryJob(jobId);

          if (!retried) {
            return status(404, { error: `Job ${jobId} not found or not in failed state` });
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
