/**
 * Error Analyzer extension - automatically analyzes job failures across all
 * core queues and workflow steps, producing structured markdown error reports.
 *
 * Subscribes to queue "failed" events and "workflow:step_failed" domain events.
 * Dispatches analysis jobs on its own queue where a recovery agent investigates
 * the failure using available tools and writes a report.
 *
 * A circuit breaker prevents infinite recursion: failures on the recovery
 * queue itself are ignored.
 *
 * State is encapsulated in a factory function so each call to
 * {@link createExtension} produces an isolated instance.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  AgentProcessorResult,
  Extension,
  ExtensionContext,
  ExtensionManifest,
  Logger,
  ManagedQueuePort,
  QueueJob,
} from "@ext/types";
import { Type } from "@sinclair/typebox";

/** Default set of monitored sources. */
const DEFAULT_MONITORED_SOURCES: string[] = ["agents", "workflows"];

/** Queue name for recovery analysis jobs (prefixed by extension system). */
const ANALYSIS_QUEUE_SUFFIX = "analysis";

/** Full prefixed queue name used for circuit breaker checks. */
const RECOVERY_QUEUE_NAME = `error-analyzer:${ANALYSIS_QUEUE_SUFFIX}`;

/** Payload for error analysis jobs. */
interface AnalysisJobData {
  /** ID of the failed job. */
  failedJobId: string;
  /** Name of the queue where the failure occurred. */
  queueName: string;
  /** Error message from the failure event. */
  failedReason: string;
  /** Original job data (prompt, context, etc.). */
  jobData: unknown;
  /** Log entries from the failed job. */
  jobLogs: Array<{ message: string; timestamp: number }>;
  /** Timestamp of the failure. */
  timestamp: number;
  /** Workflow-specific context, if applicable. */
  workflow?: {
    workflowRunId: string;
    workflowName: string;
    stepSlug: string;
  };
}

/**
 * System prompt for the error analysis agent.
 * Instructs the agent to analyze, investigate, and report - never fix.
 */
const ERROR_ANALYSIS_SYSTEM_PROMPT = `You are an error analysis agent. Your job is to analyze job failures, investigate root causes using available tools, and write structured error reports.

You have access to:
- write_file: write files in the work directory
- exec: run shell commands including:
  - skill read <name>: read skill definitions
  - workflow read <name>: read workflow YAML definitions
  - workflow list: list all workflows
  - workflow runs <name>: list recent runs for a workflow
  - workflow logs <run-id>: show per-step logs for a workflow run

Your report MUST be written as a markdown file to the path specified in the prompt.
The report MUST include these sections:

# Error Report: <jobId>

## Error Summary
What failed, in which queue, and the error message.

## Root Cause Analysis
Why it failed. Use tools to investigate if needed.

## Relevant Context
What was the job trying to do? Include the original prompt, tools used, and any workflow context.

## Suggested Fix
How to prevent this failure in the future.

## Classification
One of: infra, config, skill, workflow, prompt, unknown

IMPORTANT:
- Do NOT attempt to fix anything - only analyze and report.
- Do NOT modify any skill files, workflow definitions, or system configuration.
- Write ONLY the report file. Nothing else.`;

/**
 * Builds the analysis prompt from the failure context.
 *
 * @param data - The analysis job data containing failure details
 * @param reportPath - The file path where the report should be written
 * @returns The formatted prompt string
 */
function buildAnalysisPrompt(data: AnalysisJobData, reportPath: string): string {
  const lines: string[] = [
    `A job has failed. Analyze the failure and write a report to: ${reportPath}`,
    "",
    `**Failed Job ID:** ${data.failedJobId}`,
    `**Queue:** ${data.queueName}`,
    `**Error:** ${data.failedReason}`,
    `**Time:** ${new Date(data.timestamp).toISOString()}`,
  ];

  if (data.workflow) {
    lines.push("");
    lines.push("**Workflow Context:**");
    lines.push(`  Workflow: ${data.workflow.workflowName}`);
    lines.push(`  Step: ${data.workflow.stepSlug}`);
    lines.push(`  Run ID: ${data.workflow.workflowRunId}`);
    lines.push("");
    lines.push(`Use \`workflow read "${data.workflow.workflowName}"\` to inspect the workflow definition.`);
    lines.push(`Use \`workflow logs "${data.workflow.workflowRunId}"\` to see step-by-step execution logs.`);
  }

  if (data.jobData) {
    lines.push("");
    lines.push("**Job Data:**");
    lines.push("```json");
    lines.push(JSON.stringify(data.jobData, null, 2).slice(0, 2000));
    lines.push("```");
  }

  if (data.jobLogs.length > 0) {
    lines.push("");
    lines.push("**Job Logs (most recent):**");
    // Include last 30 log entries to keep prompt manageable
    const recentLogs = data.jobLogs.slice(-30);
    for (const log of recentLogs) {
      const ts = log.timestamp ? new Date(log.timestamp).toISOString() : "";
      lines.push(`  ${ts ? `[${ts}] ` : ""}${log.message}`);
    }
  }

  lines.push("");
  lines.push("Investigate the root cause using available tools, then write the report.");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const manifest = {
  name: "error-analyzer",
  version: "1.0.0",
  description: "Automatic failure analysis and error reporting for jobs and workflows",
  dependencies: ["workflows"],
  settingsSchema: Type.Object({
    monitoredQueues: Type.Array(Type.String(), {
      title: "Monitored Queues",
      description: "Sources to monitor for job failures",
      default: DEFAULT_MONITORED_SOURCES,
      availableItems: ["agents", "chat", "workflows"],
      dynamicItems: "all-queue-names",
    }),
    reportsPath: Type.String({
      title: "Reports Path",
      description: "Relative path within the work directory where error reports are stored",
      default: "data/error-reports",
    }),
    overridePrompt: Type.String({
      title: "System Prompt Override",
      description: "System prompt override for the error analysis agent",
      default: ERROR_ANALYSIS_SYSTEM_PROMPT,
      multiline: true,
    }),
  }),
} satisfies ExtensionManifest;

/**
 * Creates a fresh Error Recovery extension instance with its own encapsulated state.
 *
 * @returns An {@link Extension} object ready to be loaded by the registry
 */
export function createExtension(): Extension {
  let logger: Logger;
  const mutableState: {
    reportsDir: string;
    analysisQueue: ManagedQueuePort<AnalysisJobData> | null;
    /** Registered failure handlers keyed by queue name, for unsubscription. */
    failureHandlers: Map<string, (data: { jobId: string; failedReason?: string }) => void>;
    /** Whether workflow step failures are being monitored. */
    monitorWorkflows: boolean;
    /** Extension context reference for shutdown cleanup. */
    ctx: ExtensionContext | null;
  } = {
    reportsDir: "",
    analysisQueue: null,
    failureHandlers: new Map(),
    monitorWorkflows: true,
    ctx: null,
  };

  /**
   * Handles a job failure event from any queue.
   * Gathers context and enqueues an analysis job.
   *
   * @param ctx - Extension context for accessing job logs
   * @param queueName - Display name of the queue
   * @param jobId - ID of the failed job
   * @param failedReason - Error message
   * @param workflow - Optional workflow-specific context
   */
  async function handleFailure(
    ctx: ExtensionContext,
    queueName: string,
    jobId: string,
    failedReason: string,
    workflow?: AnalysisJobData["workflow"],
  ): Promise<void> {
    if (!mutableState.analysisQueue) return;

    // Circuit breaker: don't analyze our own failures
    if (queueName === RECOVERY_QUEUE_NAME) {
      logger.warn(`Skipping error analysis for recovery queue failure: ${jobId}`);
      return;
    }

    try {
      const jobLogs = await ctx.queues.getJobLogs(queueName, jobId);

      const data: AnalysisJobData = {
        failedJobId: jobId,
        queueName,
        failedReason,
        jobData: null,
        jobLogs: jobLogs.logs,
        timestamp: Date.now(),
        workflow,
      };

      await mutableState.analysisQueue.add(`Error analysis: ${queueName}/${jobId}`, data);
      logger.info(`Enqueued error analysis for failed job ${jobId} from queue "${queueName}"`);
    } catch (err) {
      logger.error(`Failed to enqueue error analysis for job ${jobId}:`, err);
    }
  }

  return {
    manifest,

    async initialize(ctx: ExtensionContext) {
      logger = ctx.log;
      mutableState.ctx = ctx;

      // --- Reports directory setup ---
      const reportsPath = ctx.getConfig<string>("REPORTS_PATH", "data/error-reports");
      mutableState.reportsDir = path.join(ctx.workDir, reportsPath);
      await mkdir(mutableState.reportsDir, { recursive: true });
      logger.info(`Error reports directory: ${mutableState.reportsDir}`);

      // --- Dynamic settings provider ---
      // Register a provider so the "Monitored Queues" multiselect in settings
      // is populated with all available queue sources at request time.
      ctx.registerDynamicItemProvider("all-queue-names", () => {
        const names = new Set(
          ctx.queues
            .getAllQueueNames()
            .map((name) => name.split(":")[0] ?? name)
            .filter((name) => name !== "error-analyzer"),
        );
        return [...names];
      });

      // --- Analysis queue ---
      mutableState.analysisQueue = ctx.createQueue<AnalysisJobData, AgentProcessorResult>(
        ANALYSIS_QUEUE_SUFFIX,
        async (job: QueueJob<AnalysisJobData>) => {
          const data = job.data;
          const timestamp = new Date(data.timestamp).toISOString().replace(/:/g, "-").slice(0, 19);
          const reportPath = path.join(mutableState.reportsDir, `${timestamp}_${data.failedJobId}.md`);
          // Convert to path relative to workDir for the agent's sandboxed filesystem
          const relativeReportPath = path.relative(ctx.workDir, reportPath);

          // Create a session for this analysis run
          const session = ctx.sessions.create({
            source: "error-analyzer",
            metadata: {
              failedJobId: data.failedJobId,
              queueName: data.queueName,
              workflow: data.workflow ?? null,
            },
          });

          const prompt = buildAnalysisPrompt(data, relativeReportPath);

          // Append the prompt to the session so the agent processor picks it up
          session.append({
            role: "user",
            content: prompt,
            timestamp: Date.now(),
          });

          return ctx.runAgent(job, {
            systemPrompt: ctx.getConfig<string>("OVERRIDE_PROMPT", ERROR_ANALYSIS_SYSTEM_PROMPT),
            tools: ["write_file"],
            skills: ["workflows", "webhooks"],
            thinkingLevel: "low",
            sessionId: session.id,
          });
        },
        {
          concurrency: 1,
          removeOnComplete: false,
          removeOnFail: false,
          useLocks: false,
          stallConfig: { stallInterval: 1000 * 60 * 5, maxStalls: 1, gracePeriod: 15000, enabled: true },
        },
      );

      // --- Queue failure subscriptions ---
      /**
       * Resolve a short source name to the actual queue name(s) to subscribe to.
       * Core queues ("agents", "chat") map directly. Extension names (e.g. "converter")
       * map to all queues prefixed with that name (e.g. "converter:jobs").
       */
      function resolveQueueNames(source: string): string[] {
        if (source === "agents" || source === "chat") return [source];
        // Extension source: find all queues whose prefix matches
        return ctx.queues.getAllQueueNames().filter((name) => name.startsWith(`${source}:`));
      }

      /**
       * Subscribe to failure events on queues matching the given source and track the handler.
       */
      function subscribeSource(source: string): void {
        if (mutableState.failureHandlers.has(source)) return;
        const queueNames = resolveQueueNames(source);
        if (queueNames.length === 0) {
          logger.debug(`No queues found for source "${source}", skipping subscription`);
          return;
        }
        const handler = ({ jobId, failedReason }: { jobId: string; failedReason?: string }) => {
          if (ctx.isEnabled()) {
            handleFailure(ctx, source, jobId, failedReason ?? "Unknown error");
          }
        };
        mutableState.failureHandlers.set(source, handler);
        for (const queueName of queueNames) {
          ctx.queues.onEvent(queueName, "failed", handler);
        }
        logger.debug(`Subscribed to failures on source "${source}" (queues: ${queueNames.join(", ")})`);
      }

      /**
       * Unsubscribe from failure events for the given source.
       */
      function unsubscribeSource(source: string): void {
        const handler = mutableState.failureHandlers.get(source);
        if (!handler) return;
        const queueNames = resolveQueueNames(source);
        for (const queueName of queueNames) {
          ctx.queues.offEvent(queueName, "failed", handler);
        }
        mutableState.failureHandlers.delete(source);
        logger.debug(`Unsubscribed from failures on source "${source}"`);
      }

      /**
       * Reconcile active subscriptions with the desired set of sources.
       */
      function syncSubscriptions(desired: string[]): void {
        const desiredSet = new Set(desired);

        // Unsubscribe from sources no longer desired
        for (const source of mutableState.failureHandlers.keys()) {
          if (!desiredSet.has(source)) unsubscribeSource(source);
        }
        // Subscribe to newly desired sources (skip "workflows" — handled via domain event)
        for (const source of desired) {
          if (source === "workflows") continue;
          subscribeSource(source);
        }

        // Workflow step monitoring (handled via domain event, not queue subscription)
        mutableState.monitorWorkflows = desiredSet.has("workflows");
      }

      const initialSources = ctx.getConfig<string[]>("MONITORED_QUEUES", DEFAULT_MONITORED_SOURCES);
      syncSubscriptions(initialSources);

      // --- React to settings changes ---
      ctx.on("settings:changed", (event) => {
        if (!("extensionName" in event) || event.extensionName !== "error-analyzer") return;
        const values = (event as { values?: Record<string, unknown> }).values;
        const raw = values?.monitoredQueues;
        if (!Array.isArray(raw)) return;

        syncSubscriptions(raw as string[]);
        logger.info(`Monitored sources updated: [${(raw as string[]).join(", ")}]`);
      });

      // --- Workflow step failure subscription ---
      ctx.on("workflow:step_failed", (event) => {
        if (!mutableState.monitorWorkflows) return;

        const wfCtx = event.context;
        if (!wfCtx) return;

        const workflowRunId = wfCtx.workflowRunId as string;
        const workflowName = wfCtx.workflowName as string;
        const stepSlug = wfCtx.stepSlug as string;
        const jobId = wfCtx.jobId as string;
        const error = (wfCtx.error as string) || "Unknown workflow step error";

        // For workflow step failures, we don't have direct queue access.
        // Enqueue with the context we have from the domain event.
        if (!mutableState.analysisQueue) return;

        const data: AnalysisJobData = {
          failedJobId: jobId,
          queueName: "workflows:steps",
          failedReason: error,
          jobData: null,
          jobLogs: [],
          timestamp: Date.now(),
          workflow: { workflowRunId, workflowName, stepSlug },
        };

        mutableState.analysisQueue
          .add(`Error analysis: workflow step ${workflowName}/${stepSlug}`, data)
          .then(() => logger.info(`Enqueued error analysis for workflow step failure: ${workflowName}/${stepSlug}`))
          .catch((err) => logger.error(`Failed to enqueue workflow step error analysis:`, err));
      });

      // --- Circuit breaker: log but ignore own queue failures ---
      mutableState.analysisQueue.onEvent("failed", ({ jobId, failedReason }) => {
        logger.warn(`Recovery analysis job ${jobId} failed (not retrying): ${failedReason}`);
      });
    },

    async shutdown() {
      // Unsubscribe from all queue failure events
      if (mutableState.ctx) {
        for (const [source, handler] of mutableState.failureHandlers) {
          // Resolve which actual queue names this source maps to
          const queueNames = mutableState.ctx.queues.getAllQueueNames().filter((name) => {
            if (source === "agents" || source === "chat") return name === source;
            return name.startsWith(`${source}:`);
          });
          for (const queueName of queueNames) {
            mutableState.ctx.queues.offEvent(queueName, "failed", handler);
          }
        }
      }
      mutableState.failureHandlers.clear();

      if (mutableState.analysisQueue) {
        await mutableState.analysisQueue.close();
        mutableState.analysisQueue = null;
      }
      mutableState.ctx = null;
    },
  };
}

export default createExtension();
