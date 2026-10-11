/**
 * Helpers for reading DAG step jobs from the steps queue.
 *
 * @module
 */

import type { DagStepJobData } from "./dagEngine";

/** Extract DAG workflow step data from a queue job. */
export function stepData(job: {
  id: string;
  data: unknown;
  state: string;
  timestamp?: number;
  finishedOn?: number;
}): DagStepJobData & { id: string; state: string; timestamp?: number; finishedOn?: number } {
  const data = job.data as DagStepJobData;
  return { ...data, id: job.id, state: job.state, timestamp: job.timestamp, finishedOn: job.finishedOn };
}

/** Filter jobs for a given run ID. */
export function runJobs(
  allJobs: { id: string; data: unknown; state: string; timestamp?: number; finishedOn?: number }[],
  runId: string,
): (DagStepJobData & { id: string; state: string; timestamp?: number; finishedOn?: number })[] {
  return allJobs.map(stepData).filter((d) => d.workflowRunId === runId);
}

/**
 * Builds a map from step slug to its real queue job ID for a run.
 *
 * The run ID is not a job ID, so per-step log retrieval (GET
 * /api/jobs/:jobId/logs) needs the actual job ID that executed each step. Steps
 * that never produced a job (control-flow nodes, dead branches) are absent from
 * the map. When a slug has multiple jobs (e.g. retries), the last one wins so
 * the freshest job's logs are surfaced.
 *
 * @param jobs - Queue jobs already filtered to a single run (see {@link runJobs}).
 * @returns A map of step slug to job ID.
 */
export function buildStepJobIdMap(jobs: { stepSlug: string; id: string }[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const job of jobs) {
    map.set(job.stepSlug, job.id);
  }
  return map;
}
