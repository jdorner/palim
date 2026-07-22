/**
 * Workflows extension - enables multi-step job pipelines defined in JSON5.
 *
 * Exposes:
 * - `GET    /ext/workflows`              - list loaded workflow definitions
 * - `GET    /ext/workflows/:name`        - get a single workflow definition
 * - `POST   /ext/workflows`              - create a new workflow definition
 * - `PUT    /ext/workflows/:name`        - update an existing workflow definition
 * - `POST   /ext/workflows/run/:name`    - trigger a workflow run
 * - `GET    /ext/workflows/runs/:runId`  - get run status with per-step states
 * - `GET    /ext/workflows/runs/:runId/logs` - get per-step execution logs
 * - `DELETE /ext/workflows/runs/:runId`  - cancel all steps of a workflow run
 * - `DELETE /ext/workflows/:name`        - delete a workflow definition (removes JSON5 file)
 *
 * Workflow definitions are loaded from `WORK_DIR/workflows/*.json5` at startup.
 * Steps execute sequentially via bunqueue's {@link FlowProducer.addChain}.
 *
 * State is encapsulated in a factory function so each call to
 * {@link createExtension} produces an isolated instance.
 */

import { type FSWatcher, watch } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { Extension, ExtensionContext, ExtensionManifest, Logger } from "@ext/types";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { Value } from "@sinclair/typebox/value";
import { serverOrigin } from "@src/config";
import { SANDBOX_TOOL_NAMES } from "@src/tools/file";
import type { SessionFactory } from "./engine";
import { dispatchWorkflow } from "./engine";
import { loadWorkflows } from "./loader";
import type { WorkflowDefinition } from "./schemas";
import { WorkflowDefinitionSchema } from "./schemas";
import type { TemplateSecretResolver } from "./template";
import { validateWorkflowTemplates } from "./templateValidation";
import type { WorkflowStepJobData } from "./types";
import { createStepProcessor } from "./worker";

/**
 * Derives the overall run status from the states of its individual steps.
 *
 * @param stepStatuses - Array of per-step job state strings
 * @returns `"failed"` if any step failed/unknown, `"completed"` if all steps completed,
 *          `"queued"` if all steps are still waiting, otherwise `"running"`
 */
function buildRunStatus(stepStatuses: string[]): "failed" | "completed" | "running" | "queued" {
  if (stepStatuses.some((s) => s === "failed" || s === "unknown")) return "failed";
  if (stepStatuses.length > 0 && stepStatuses.every((s) => s === "completed")) return "completed";
  if (
    stepStatuses.length > 0 &&
    stepStatuses.every((s) => s === "waiting" || s === "created" || s === "delayed" || s === "waiting-children")
  )
    return "queued";
  return "running";
}

/** Extract workflow step data from a queue job. */
function stepData(job: {
  id: string;
  data: unknown;
  state: string;
  timestamp?: number;
  finishedOn?: number;
}): WorkflowStepJobData & { id: string; state: string; timestamp?: number; finishedOn?: number } {
  const data = job.data as WorkflowStepJobData;
  return { ...data, id: job.id, state: job.state, timestamp: job.timestamp, finishedOn: job.finishedOn };
}

/** Filter jobs for a given run ID. */
function runJobs(
  allJobs: { id: string; data: unknown; state: string; timestamp?: number; finishedOn?: number }[],
  runId: string,
): (WorkflowStepJobData & { id: string; state: string; timestamp?: number; finishedOn?: number })[] {
  return allJobs.map(stepData).filter((d) => d.workflowRunId === runId);
}

/** Result of validating tool and skill availability for a workflow. */
export interface WorkflowValidationResult {
  /** Whether all referenced tools and skills are available. */
  valid: boolean;
  /** Tool names referenced in steps that are not available. */
  missingTools: string[];
  /** Skill names referenced in steps that are not available. */
  missingSkills: string[];
}

/**
 * Validates that all tools and skills referenced by a workflow's agent steps
 * are currently available. Checks tool names against both extension-registered
 * tools and sandbox tools, and skill names against the skill registry.
 *
 * @param definition - The workflow definition to validate
 * @param ctx - Extension context for querying available tools and skills
 * @returns Validation result with lists of missing tools and skills
 */
export function validateWorkflowDependencies(
  definition: WorkflowDefinition,
  ctx: ExtensionContext,
): WorkflowValidationResult {
  const availableTools = new Set([...ctx.getToolNames(), ...SANDBOX_TOOL_NAMES]);
  const availableSkills = new Set(ctx.skills.getNames());

  const missingTools = new Set<string>();
  const missingSkills = new Set<string>();

  for (const step of definition.steps) {
    if (step.type !== "agent") continue;

    const agentStep = step as import("./schemas").AgentStep;

    if (agentStep.tools) {
      for (const tool of agentStep.tools) {
        if (!availableTools.has(tool)) missingTools.add(tool);
      }
    }

    if (agentStep.skills) {
      for (const skill of agentStep.skills) {
        if (!availableSkills.has(skill)) missingSkills.add(skill);
      }
    }
  }

  return {
    valid: missingTools.size === 0 && missingSkills.size === 0,
    missingTools: [...missingTools].sort(),
    missingSkills: [...missingSkills].sort(),
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const manifest = {
  name: "workflows",
  version: "1.0.0",
  description: "Multi-step job pipelines defined in JSON5",
  dependencies: [],
  core: true,
  ui: {
    navigation: [
      {
        label: "Workflows",
        route: "/workflows",
        icon: "FlowArrowIcon",
        order: 50,
        badgeKey: "workflowCount",
        iconColor: "text-violet-500 dark:text-violet-300",
      },
    ],
  },
} satisfies ExtensionManifest;

/**
 * Creates a fresh Workflows extension instance with its own encapsulated state.
 *
 * @returns An {@link Extension} object ready to be loaded by the registry
 */
export function createExtension(): Extension {
  let logger: Logger;

  /** Loaded workflow definitions, keyed by name. */
  const store = new Map<string, WorkflowDefinition>();

  /** Mutable extension state. */
  const state: {
    watcher: FSWatcher | null;
    reloadTimer: ReturnType<typeof setTimeout> | null;
    workflowsDir: string;
  } = {
    watcher: null,
    reloadTimer: null,
    workflowsDir: "",
  };

  /**
   * Reloads all workflow definitions from disk, debounced.
   */
  function scheduleReload(ctx: ExtensionContext) {
    if (state.reloadTimer) clearTimeout(state.reloadTimer);
    state.reloadTimer = setTimeout(async () => {
      state.reloadTimer = null;
      try {
        const loaded = await loadWorkflows(state.workflowsDir, logger);
        store.clear();
        for (const [k, v] of loaded) store.set(k, v);
        logger.info(`Reloaded ${store.size} workflow definition(s)`);
        ctx.broadcast({ type: "workflow_reload" });
      } catch (err) {
        logger.error("Failed to reload workflows:", err);
      }
    }, 300);
  }

  return {
    manifest,

    async initialize(ctx: ExtensionContext) {
      logger = ctx.log;
      const flowProducer = ctx.queues.getFlowProducer();
      const sessionFactory: SessionFactory = { create: (opts) => ctx.sessions.create(opts) };

      // Load workflow definitions
      state.workflowsDir = path.join(ctx.workDir, "workflows");
      await mkdir(state.workflowsDir, { recursive: true });

      const loaded = await loadWorkflows(state.workflowsDir, logger);
      store.clear();
      for (const [k, v] of loaded) store.set(k, v);
      logger.info(`Loaded ${store.size} workflow definition(s)`);

      // Watch for file changes and hot-reload
      try {
        state.watcher = watch(state.workflowsDir, (_event, filename) => {
          if (filename?.endsWith(".json5")) {
            logger.debug(`Workflow file changed: ${filename}`);
            scheduleReload(ctx);
          }
        });
        state.watcher.on("error", (err) => logger.error("Workflow watcher error:", err));
        logger.info(`Watching ${state.workflowsDir} for workflow changes`);
      } catch (err) {
        logger.warn("Could not start workflow file watcher:", err);
      }

      // Create the steps queue
      const stepsQueue = ctx.createQueue<WorkflowStepJobData>(
        "steps",
        createStepProcessor({
          ctx,
          flowProducer,
          emitEvent: (event: AgentEvent, jobId: string, jobData: WorkflowStepJobData) => {
            ctx.emitEvent({
              ...event,
              context: {
                source: "workflows",
                id: jobData.workflowRunId,
                jobId,
                workflowName: jobData.workflowName,
                stepSlug: jobData.stepSlug,
              },
            });
          },
          log: logger,
          getStepHandler: (type) => ctx.getStepHandler(type),
        }),
        {
          concurrency: 1,
          removeOnComplete: false,
          removeOnFail: false,
          useLocks: false,
          stallConfig: { stallInterval: 1000 * 60 * 5, maxStalls: 1, gracePeriod: 15000, enabled: true },
        },
      );

      // Wire queue events -> WebSocket broadcasts
      stepsQueue.onEvent("active", ({ job }) => {
        if (!job) return;
        const d = stepData(job);
        ctx.broadcast({
          type: "workflow_step_started",
          workflowRunId: d.workflowRunId,
          stepSlug: d.stepSlug,
          jobId: d.id,
        });
      });
      stepsQueue.onEvent("completed", ({ job }) => {
        if (!job) return;
        const d = stepData(job);
        ctx.broadcast({
          type: "workflow_step_completed",
          workflowRunId: d.workflowRunId,
          stepSlug: d.stepSlug,
          jobId: d.id,
        });
        if (d.stepIndex === d.totalSteps - 1) {
          ctx.broadcast({ type: "workflow_completed", workflowRunId: d.workflowRunId });
        }
      });
      stepsQueue.onEvent("failed", ({ jobId, failedReason, job }) => {
        if (!job) return;
        const d = stepData(job);
        ctx.broadcast({
          type: "workflow_step_failed",
          workflowRunId: d.workflowRunId,
          stepSlug: d.stepSlug,
          jobId: d.id,
          error: failedReason,
        });
        ctx.broadcast({
          type: "workflow_failed",
          workflowRunId: d.workflowRunId,
          failedStep: d.stepSlug,
          error: failedReason,
        });

        // Emit domain event for cross-extension consumption (e.g. error-analyzer)
        // Only emit after the job failed permanently (not just delayed because of retry attempts)
        if (d.state === "failed") {
          ctx.emitEvent({
            type: "workflow:step_failed",
            context: {
              source: "workflows",
              id: d.workflowRunId,
              workflowRunId: d.workflowRunId,
              workflowName: d.workflowName,
              stepSlug: d.stepSlug,
              jobId,
              error: failedReason,
            },
          });
        }
      });

      // --- Shared trigger event handler ---

      /**
       * Matches a trigger event against loaded workflow definitions and dispatches
       * any matching workflows. Used by all three event subscriptions (webhook,
       * filewatcher, scheduler) to avoid duplicated handler logic.
       *
       * @param triggerType - The workflow trigger type to match (e.g. "webhook", "filewatcher", "schedule")
       * @param slug - The event slug to match against workflow `trigger.ref`
       * @param payload - The trigger payload passed to the workflow as `triggerPayload`
       * @param sourceLabel - Human-readable label for log messages (e.g. "Webhook", "File watcher", "Schedule")
       */
      async function matchAndDispatch(
        triggerType: string,
        slug: string,
        payload: unknown,
        sourceLabel: string,
      ): Promise<void> {
        for (const wf of store.values()) {
          if (wf.trigger.type === triggerType && wf.trigger.ref === slug && (wf.enabled ?? true)) {
            try {
              const result = await dispatchWorkflow(flowProducer, wf, payload, logger, sessionFactory);
              ctx.broadcast({
                type: "workflow_started",
                workflowRunId: result.workflowRunId,
                workflowName: wf.name,
                steps: wf.steps.map((s, i) => ({
                  slug: s.slug,
                  type: s.type,
                  jobId: result.jobIds[i],
                })),
              });
              logger.info(`${sourceLabel} "${slug}" triggered workflow "${wf.name}" -> run ${result.workflowRunId}`);
            } catch (err) {
              logger.error(`Failed to dispatch workflow "${wf.name}" for ${sourceLabel.toLowerCase()} "${slug}":`, err);
            }
          }
        }
      }

      // --- Subscribe to webhook events for trigger matching ---
      ctx.on("webhook:received", async (event) => {
        const slug = event.context?.slug as string | undefined;
        if (!slug) return;
        await matchAndDispatch("webhook", slug, event.context?.payload, "Webhook");
      });

      // --- Subscribe to file watcher events for trigger matching ---
      ctx.on("filewatcher:detected", async (event) => {
        const slug = event.context?.slug as string | undefined;
        if (!slug) return;
        await matchAndDispatch("filewatcher", slug, event.context, "File watcher");
      });

      // --- Subscribe to scheduler events for trigger matching ---
      ctx.on("scheduler:fired", async (event) => {
        const slug = event.context?.slug as string | undefined;
        if (!slug) return;
        await matchAndDispatch("schedule", slug, event.context, "Schedule");
      });

      // --- Routes ---

      // Adapter: wrap ctx.secrets into a TemplateSecretResolver for validation
      const secretResolver: TemplateSecretResolver | undefined = ctx.secrets?.resolveAs
        ? {
            async resolve(name: string, consumer: string) {
              const value = await ctx.secrets.resolveAs!(name, consumer);
              return { value, granted: value !== null, reason: value === null ? "denied or not found" : undefined };
            },
          }
        : undefined;

      ctx.registerRoute("GET", "/meta/tools", async () => {
        const names = ctx.getToolNames().sort();
        return Response.json(names);
      });

      ctx.registerRoute("GET", "/meta/skills", async () => {
        const names = ctx.skills.getNames().sort();
        return Response.json(names);
      });

      /**
       * Returns available trigger refs grouped by trigger type.
       * Used by the frontend to populate a dropdown when editing trigger.ref.
       * Queries sibling extensions via their REST APIs to maintain isolation.
       *
       * @returns `{ webhook: string[], schedule: string[], filewatcher: string[] }`
       */
      ctx.registerRoute("GET", "/meta/triggers", async () => {
        const origin = serverOrigin();

        const [webhookSlugs, schedulerIds, filewatcherSlugs] = await Promise.all([
          ctx
            .fetch(`${origin}/ext/webhooks`)
            .then((r) => (r.ok ? (r.json() as Promise<{ slug: string }[]>) : []))
            .then((list) => list.map((w) => w.slug))
            .catch(() => [] as string[]),
          ctx
            .fetch(`${origin}/ext/scheduler/schedules`)
            .then((r) => (r.ok ? (r.json() as Promise<{ id: string }[]>) : []))
            .then((list) => list.map((s) => s.id))
            .catch(() => [] as string[]),
          ctx
            .fetch(`${origin}/ext/filewatcher`)
            .then((r) => (r.ok ? (r.json() as Promise<{ slug: string }[]>) : []))
            .then((list) => list.map((w) => w.slug))
            .catch(() => [] as string[]),
        ]);

        return Response.json({
          webhook: webhookSlugs.sort(),
          schedule: schedulerIds.sort(),
          filewatcher: filewatcherSlugs.sort(),
        });
      });

      ctx.registerRoute("GET", "/", async () => {
        const allJobs = await stepsQueue.getAllJobs();

        // Group jobs by workflow name and run ID, then derive per-run status
        const runsByWorkflow = new Map<string, Map<string, string[]>>();
        for (const d of allJobs.map(stepData)) {
          if (!runsByWorkflow.has(d.workflowName)) runsByWorkflow.set(d.workflowName, new Map());
          const runs = runsByWorkflow.get(d.workflowName)!;
          if (!runs.has(d.workflowRunId)) runs.set(d.workflowRunId, []);
          runs.get(d.workflowRunId)!.push(d.state);
        }

        const list = await Promise.all(
          [...store.values()].map(async (w) => {
            let activeRuns = 0;
            let completedRuns = 0;
            let failedRuns = 0;
            const runs = runsByWorkflow.get(w.name);
            if (runs) {
              for (const stepStatuses of runs.values()) {
                const status = buildRunStatus(stepStatuses);
                switch (status) {
                  case "completed":
                    completedRuns++;
                    break;
                  case "failed":
                    failedRuns++;
                    break;
                  case "running":
                  case "queued":
                    activeRuns++;
                    break;
                  default:
                    break;
                }
              }
            }

            const templateWarnings = await validateWorkflowTemplates(w, {
              workflowName: w.name,
              secretStore: secretResolver,
            });

            return {
              name: w.name,
              description: w.description,
              trigger: w.trigger,
              stepCount: w.steps.length,
              enabled: w.enabled ?? true,
              steps: w.steps.map((s) => ({ slug: s.slug, type: s.type })),
              activeRuns,
              completedRuns,
              failedRuns,
              warnings: templateWarnings,
            };
          }),
        );
        return Response.json(list);
      });

      ctx.registerRoute("GET", "/:name", async (reqCtx) => {
        const name = (reqCtx.params as Record<string, string>).name;
        const wf = store.get(name ?? "");
        if (!wf) return Response.json({ error: "Workflow not found" }, { status: 404 });

        const allJobs = await stepsQueue.getAllJobs();

        const runMap = new Map<
          string,
          {
            status: string;
            startedAt: number;
            completedAt?: number;
            steps: Array<{ slug: string; status: string; jobId: string; stepIndex: number; finishedOn?: number }>;
          }
        >();
        for (const d of allJobs.map(stepData)) {
          if (d.workflowName !== name) continue;
          if (!runMap.has(d.workflowRunId))
            runMap.set(d.workflowRunId, { status: "running", startedAt: d.timestamp ?? Date.now(), steps: [] });
          const run = runMap.get(d.workflowRunId)!;
          run.steps.push({
            slug: d.stepSlug,
            status: d.state,
            jobId: d.id,
            stepIndex: d.stepIndex,
            finishedOn: d.finishedOn,
          });
          run.status = buildRunStatus(run.steps.map((s) => s.status));
        }

        // Sort steps within each run by their original definition order
        for (const run of runMap.values()) {
          run.steps.sort((a, b) => a.stepIndex - b.stepIndex);
          // Derive completedAt as the latest finishedOn among all steps (only if run is terminal)
          if (run.status === "completed" || run.status === "failed") {
            const finishedTimes = run.steps.map((s) => s.finishedOn).filter((t): t is number => t != null);
            if (finishedTimes.length > 0) {
              run.completedAt = Math.max(...finishedTimes);
            }
          }
        }

        const runs = [...runMap.entries()]
          .map(([runId, run]) => ({
            runId,
            ...run,
            steps: run.steps.map(({ stepIndex: _, finishedOn: __, ...rest }) => rest),
          }))
          .sort((a, b) => b.startedAt - a.startedAt)
          .slice(0, 20);

        const templateWarnings = await validateWorkflowTemplates(wf, {
          workflowName: wf.name,
          secretStore: secretResolver,
        });

        return Response.json({ ...wf, runs, warnings: templateWarnings });
      });

      /**
       * Creates a new workflow definition on disk and makes it immediately available.
       *
       * @returns `{ ok: true, name: "<name>" }` on success (201), or an error response (400/409/500)
       */
      ctx.registerRoute("POST", "/", async (_reqCtx) => {
        return Response.json({ error: "Function not available" }, { status: 500 });

        /*const body = reqCtx.body;

        // Validate body against schema
        if (!Value.Check(WorkflowDefinitionSchema, body)) {
          const errors = [...Value.Errors(WorkflowDefinitionSchema, body)];
          return Response.json(
            { error: "Validation failed", details: errors.map((e) => `${e.path}: ${e.message}`).join(", ") },
            { status: 400 },
          );
        }

        // Manual triggers must not include a ref
        if (body.trigger.type === "manual" && body.trigger.ref) {
          return Response.json({ error: "Manual triggers do not support a ref value" }, { status: 400 });
        }

        // Explicit name pattern check for a more specific error message
        if (!/^[a-z][a-z0-9-]*$/.test(body.name)) {
          return Response.json({ error: "Name must match pattern ^[a-z][a-z0-9-]*$" }, { status: 400 });
        }

        // Check for duplicate step slugs
        const slugs = body.steps.map((s: { slug: string }) => s.slug);
        const duplicates = slugs.filter((s: string, i: number) => slugs.indexOf(s) !== i);
        if (duplicates.length > 0) {
          return Response.json({ error: `Duplicate step slug: ${duplicates[0]}` }, { status: 400 });
        }

        // Check for name conflicts in the in-memory store
        if (store.has(body.name)) {
          return Response.json({ error: `Workflow '${body.name}' already exists` }, { status: 409 });
        }

        // Write new workflow definition to disk
        const filePath = path.join(state.workflowsDir, `${body.name}.json5`);
        try {
          await Bun.write(filePath, JSON.stringify(body, null, 2));
        } catch (err) {
          logger.error(`Failed to write workflow file "${filePath}":`, err);
          return Response.json({ error: "Failed to write workflow file" }, { status: 500 });
        }

        // Update in-memory store immediately so subsequent reads return fresh data
        store.set(body.name, body);
        // Also schedule a full reload for any side effects (file watcher coalescing)
        scheduleReload(ctx);
        return Response.json({ ok: true, name: body.name }, { status: 201 });*/
      });

      ctx.registerRoute("POST", "/run/:name", async (reqCtx) => {
        const name = (reqCtx.params as Record<string, string>).name;
        const wf = store.get(name ?? "");
        if (!wf) return Response.json({ error: "Workflow not found" }, { status: 404 });

        const payload = reqCtx.body ?? null;
        const result = await dispatchWorkflow(flowProducer, wf, payload, logger, sessionFactory);
        ctx.broadcast({
          type: "workflow_started",
          workflowRunId: result.workflowRunId,
          workflowName: wf.name,
          steps: wf.steps.map((s, i) => ({
            slug: s.slug,
            type: s.type,
            jobId: result.jobIds[i],
          })),
        });
        return Response.json({ ok: true, workflowRunId: result.workflowRunId, jobIds: result.jobIds }, { status: 202 });
      });

      ctx.registerRoute("GET", "/runs/:runId", async (reqCtx) => {
        const runId = (reqCtx.params as Record<string, string>).runId;
        if (!runId) return Response.json({ error: "Missing runId" }, { status: 400 });
        const steps = runJobs(await stepsQueue.getAllJobs(), runId);
        if (steps.length === 0) return Response.json({ error: "Run not found" }, { status: 404 });
        const sorted = [...steps].sort((a, b) => a.stepIndex - b.stepIndex);
        const workflowName = sorted[0]!.workflowName;
        const wf = store.get(workflowName);
        return Response.json({
          runId,
          workflowName,
          status: buildRunStatus(sorted.map((s) => s.state)),
          trigger: wf?.trigger ?? null,
          steps: sorted.map((d) => ({
            slug: d.stepSlug,
            type: d.stepDef.type,
            status: d.state,
            jobId: d.id,
          })),
        });
      });

      ctx.registerRoute("GET", "/runs/:runId/logs", async (reqCtx) => {
        const runId = (reqCtx.params as Record<string, string>).runId;
        if (!runId) return Response.json({ error: "Missing runId" }, { status: 400 });
        const stepJobs = runJobs(await stepsQueue.getAllJobs(), runId);
        if (stepJobs.length === 0) return Response.json({ error: "Run not found" }, { status: 404 });
        stepJobs.sort((a, b) => a.stepIndex - b.stepIndex);

        const stepsWithLogs = await Promise.all(
          stepJobs.map(async (s) => {
            const jobLogs = await stepsQueue.getJobLogs(s.id);
            return {
              slug: s.stepSlug,
              type: s.stepDef.type,
              status: s.state,
              logs: jobLogs.logs,
              count: jobLogs.count,
            };
          }),
        );
        return Response.json({ runId, steps: stepsWithLogs });
      });

      ctx.registerRoute("POST", "/runs/:runId/retry", async (reqCtx) => {
        const runId = (reqCtx.params as Record<string, string>).runId;
        if (!runId) return Response.json({ error: "Missing runId" }, { status: 400 });
        const steps = runJobs(await stepsQueue.getAllJobs(), runId);
        if (steps.length === 0) return Response.json({ error: "Run not found" }, { status: 404 });
        const sorted = [...steps].sort((a, b) => a.stepIndex - b.stepIndex);
        const status = buildRunStatus(sorted.map((s) => s.state));
        if (status !== "failed") return Response.json({ error: "Only failed runs can be retried" }, { status: 409 });

        // Retry all failed steps via the DLQ mechanism (child-first order so
        // parent steps unblock once their children are re-queued).
        const retried: string[] = [];
        for (const step of sorted) {
          if (step.state === "failed") {
            const ok = await stepsQueue.retryJob(step.id);
            if (ok) retried.push(step.id);
          }
        }

        if (retried.length === 0) {
          return Response.json({ error: "No failed steps could be retried" }, { status: 500 });
        }

        ctx.broadcast({
          type: "workflow_started",
          workflowRunId: runId,
          workflowName: sorted[0]!.workflowName,
          steps: sorted.map((s) => ({
            slug: s.stepSlug,
            type: s.stepDef.type,
            jobId: s.id,
          })),
        });
        logger.info(`Retried workflow run ${runId} (${retried.length} failed step(s) re-queued)`);
        return Response.json({ ok: true, workflowRunId: runId, retriedSteps: retried }, { status: 202 });
      });

      ctx.registerRoute("DELETE", "/runs/:runId", async (reqCtx) => {
        const runId = (reqCtx.params as Record<string, string>).runId;
        if (!runId) return Response.json({ error: "Missing runId" }, { status: 400 });
        const stepJobs = runJobs(await stepsQueue.getAllJobs(), runId);
        if (stepJobs.length === 0) {
          return Response.json({ error: "Run not found" }, { status: 404 });
        }

        const cancelled: string[] = [];
        for (const d of stepJobs) {
          const removed = await stepsQueue.cancelJob(d.id);
          if (removed) cancelled.push(d.id);
        }

        // Notify frontend clients about removed jobs
        for (const jobId of cancelled) {
          ctx.broadcast({ type: "job_removed", jobId });
        }

        logger.info(`Cancelled workflow run ${runId} (${cancelled.length}/${stepJobs.length} jobs removed)`);
        return Response.json({ runId, cancelled, total: stepJobs.length });
      });

      /**
       * Updates an existing workflow definition on disk and reloads the in-memory store.
       *
       * @returns `{ ok: true }` on success, or an error response (400/404/500)
       */
      ctx.registerRoute("PUT", "/:name", async (reqCtx) => {
        const name = (reqCtx.params as Record<string, string>).name;
        const body = reqCtx.body;

        // Validate body against schema
        if (!Value.Check(WorkflowDefinitionSchema, body)) {
          const errors = [...Value.Errors(WorkflowDefinitionSchema, body)];
          return Response.json(
            { error: "Validation failed", details: errors.map((e) => `${e.path}: ${e.message}`).join(", ") },
            { status: 400 },
          );
        }

        // Manual triggers must not include a ref
        if (body.trigger.type === "manual" && body.trigger.ref) {
          return Response.json({ error: "Manual triggers do not support a ref value" }, { status: 400 });
        }

        // Non-manual triggers require a ref
        if (body.trigger.type !== "manual" && !body.trigger.ref) {
          return Response.json({ error: `Trigger type "${body.trigger.type}" requires a ref value` }, { status: 400 });
        }

        // Validate that trigger.ref exists for the given trigger type
        if (body.trigger.type !== "manual" && body.trigger.ref) {
          const triggerType = body.trigger.type;
          const ref = body.trigger.ref;
          const origin = serverOrigin();
          let refExists = false;

          try {
            if (triggerType === "webhook") {
              const res = await ctx.fetch(`${origin}/ext/webhooks/${encodeURIComponent(ref)}`);
              refExists = res.ok;
            } else if (triggerType === "filewatcher") {
              const res = await ctx.fetch(`${origin}/ext/filewatcher`);
              if (res.ok) {
                const list = (await res.json()) as { slug: string }[];
                refExists = list.some((w) => w.slug === ref);
              }
            } else if (triggerType === "schedule") {
              const res = await ctx.fetch(`${origin}/ext/scheduler/schedules`);
              if (res.ok) {
                const list = (await res.json()) as { id: string }[];
                refExists = list.some((s) => s.id === ref);
              }
            }
          } catch {
            // If sibling extension is unavailable, skip validation
            refExists = true;
          }

          if (!refExists) {
            return Response.json(
              { error: `Trigger ref "${ref}" does not exist for type "${triggerType}"` },
              { status: 400 },
            );
          }
        }

        // Ensure body name matches URL parameter
        if (body.name !== name) {
          return Response.json({ error: "Name in body does not match URL parameter" }, { status: 400 });
        }

        // Check workflow exists in store
        if (!store.has(name!)) {
          return Response.json({ error: "Workflow not found" }, { status: 404 });
        }

        // Find the JSON5 file on disk
        const glob = new Bun.Glob("*.json5");
        let targetFile: string | null = null;
        for (const entry of glob.scanSync({ cwd: state.workflowsDir, absolute: false })) {
          try {
            const content = await Bun.file(path.join(state.workflowsDir, entry)).text();
            const parsed = Bun.JSON5.parse(content) as Record<string, unknown>;
            if (parsed?.name === name) {
              targetFile = path.join(state.workflowsDir, entry);
              break;
            }
          } catch {
            // skip unreadable files
          }
        }

        if (!targetFile) return Response.json({ error: "Workflow not found" }, { status: 404 });

        // Write updated definition to disk
        try {
          await Bun.write(targetFile, JSON.stringify(body, null, 2));
        } catch (err) {
          logger.error(`Failed to write workflow file "${targetFile}":`, err);
          return Response.json({ error: "Failed to write workflow file" }, { status: 500 });
        }

        // Update in-memory store immediately so subsequent reads return fresh data
        store.set(body.name, body);
        // Also schedule a full reload for any side effects (file watcher coalescing)
        scheduleReload(ctx);
        return Response.json({ ok: true });
      });

      ctx.registerRoute("DELETE", "/:name", async (reqCtx) => {
        const name = (reqCtx.params as Record<string, string>).name;
        const wf = store.get(name ?? "");
        if (!wf) return Response.json({ error: "Workflow not found" }, { status: 404 });

        // Find the JSON5 file that contains this workflow
        const glob = new Bun.Glob("*.json5");
        let targetFile: string | null = null;
        for (const entry of glob.scanSync({ cwd: state.workflowsDir, absolute: false })) {
          try {
            const content = await Bun.file(path.join(state.workflowsDir, entry)).text();
            const parsed = Bun.JSON5.parse(content) as Record<string, unknown>;
            if (parsed?.name === name) {
              targetFile = path.join(state.workflowsDir, entry);
              break;
            }
          } catch {
            // skip unreadable files
          }
        }

        if (!targetFile) return Response.json({ error: "Workflow file not found on disk" }, { status: 404 });

        await unlink(targetFile);
        store.delete(name!);
        ctx.broadcast({ type: "workflow_deleted", workflowName: name! });
        logger.info(`Deleted workflow "${name}" (${targetFile})`);
        return Response.json({ ok: true });
      });
    },

    async shutdown() {
      if (state.watcher) {
        state.watcher.close();
        state.watcher = null;
      }
      if (state.reloadTimer) {
        clearTimeout(state.reloadTimer);
        state.reloadTimer = null;
      }
      store.clear();
    },
  };
}

const defaultInstance = createExtension();
export default defaultInstance;
export { buildRunStatus, dispatchWorkflow };
