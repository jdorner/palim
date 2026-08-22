/**
 * Workflows extension - enables DAG job pipelines defined in JSON5.
 *
 * Exposes:
 * - `GET    /ext/workflows`              - list loaded workflow definitions
 * - `GET    /ext/workflows/:name`        - get a single workflow definition
 * - `PUT    /ext/workflows/:name`        - update an existing workflow definition
 * - `POST   /ext/workflows/run/:name`    - trigger a workflow run
 * - `GET    /ext/workflows/runs/:runId`  - get run status with per-step states
 * - `GET    /ext/workflows/runs/:runId/logs` - get per-step execution logs
 * - `POST   /ext/workflows/runs/:runId/signal/:event` - deliver a signal to a waiting run
 * - `DELETE /ext/workflows/runs/:runId`  - cancel all steps of a workflow run
 * - `DELETE /ext/workflows/:name`        - delete a workflow definition (removes JSON5 file)
 *
 * Workflow definitions are loaded from `WORK_DIR/workflows/*.json5` at startup.
 * Steps execute as a DAG: fan-out (parallel) and join (convergence) are supported.
 *
 * State is encapsulated in a factory function so each call to
 * {@link createExtension} produces an isolated instance.
 */

import { type FSWatcher, watch } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { Extension, ExtensionContext, ExtensionManifest, Logger } from "@ext/types";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { setWorkflowDispatchFn } from "@src/extensions/engine/extensionContext";
import { SANDBOX_TOOL_NAMES } from "@src/tools/file";
import {
  type DagCoordinatorDeps,
  evaluateInlineRoot,
  handleDagStepCompletion,
  handleDagStepFailure,
  resumeWaitForNode,
} from "./dagCoordinator";
import { createDagEmitHandler } from "./dagEmitHandler";
import { type DagStepJobData, dispatchDagWorkflow, type SessionFactory } from "./dagEngine";
import { loadDagWorkflows } from "./dagLoader";
import * as dagRunStore from "./dagRunStore";
import { initDagRunStore } from "./dagRunStore";
import { type TemplateWarning, validateDagWorkflowTemplates } from "./dagTemplateValidation";
import { validateCfEdges, validateDag } from "./dagValidation";
import { createDagStepProcessor } from "./dagWorker";
import type { DagWorkflowDefinition, OutputSchema } from "./schemas";
import { DagWorkflowDefinitionSchema } from "./schemas";
import * as signalStore from "./signalStore";
import { initSignalStore } from "./signalStore";
import * as signalTimers from "./signalTimers";
import type { TemplateSecretResolver } from "./template";
import { resolveTriggerOutputSchema } from "./triggerSchemas";

/** Extract DAG workflow step data from a queue job. */
function stepData(job: {
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
function runJobs(
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

/** Built-in step types handled directly by the workflow engine. */
const BUILTIN_STEP_TYPES = new Set(["agent", "if", "case", "waitFor"]);

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
 * are currently available.
 *
 * @param definition - The DAG workflow definition to validate
 * @param ctx - Extension context for querying available tools and skills
 * @returns Validation result with lists of missing tools and skills
 */
export function validateWorkflowDependencies(
  definition: DagWorkflowDefinition,
  ctx: ExtensionContext,
): WorkflowValidationResult {
  const availableTools = new Set([...ctx.tools.names(), ...SANDBOX_TOOL_NAMES]);
  const availableSkills = new Set(ctx.skills.names());

  const missingTools = new Set<string>();
  const missingSkills = new Set<string>();

  for (const stepDef of Object.values(definition.steps)) {
    if (stepDef.type !== "agent") continue;
    const agentStep = stepDef as { tools?: string[]; skills?: string[] };

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

/**
 * Produces per-step warnings for dependencies that are not currently available.
 *
 * @param definition - The DAG workflow definition to check
 * @param ctx - Extension context for querying available tools, skills, and step handlers
 * @returns Array of per-step warnings (empty if all dependencies are satisfied)
 */
function getDependencyWarnings(definition: DagWorkflowDefinition, ctx: ExtensionContext): TemplateWarning[] {
  const availableTools = new Set([...ctx.tools.names(), ...SANDBOX_TOOL_NAMES]);
  const availableSkills = new Set(ctx.skills.names());
  const warnings: TemplateWarning[] = [];

  for (const [slug, stepDef] of Object.entries(definition.steps)) {
    // Check custom (extension-registered) step types are available
    if (!BUILTIN_STEP_TYPES.has(stepDef.type)) {
      const handler = ctx.stepTypes.get(stepDef.type);
      if (!handler) {
        warnings.push({
          stepSlug: slug,
          field: "type",
          message: `Step type "${stepDef.type}" is not available (extension disabled or not installed)`,
        });
      }
      continue;
    }

    if (stepDef.type !== "agent") continue;
    const agentStep = stepDef as { tools?: string[]; skills?: string[] };

    if (agentStep.tools) {
      for (const tool of agentStep.tools) {
        if (!availableTools.has(tool)) {
          warnings.push({
            stepSlug: slug,
            field: "tools",
            message: `Tool "${tool}" is not available (not registered or extension disabled)`,
          });
        }
      }
    }
    if (agentStep.skills) {
      for (const skill of agentStep.skills) {
        if (!availableSkills.has(skill)) {
          warnings.push({
            stepSlug: slug,
            field: "skills",
            message: `Skill "${skill}" is not available (not found or extension disabled)`,
          });
        }
      }
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const manifest = {
  name: "workflows",
  version: "1.0.0",
  description: "DAG job pipelines defined in JSON5",
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

  /** Loaded DAG workflow definitions, keyed by name. */
  const store = new Map<string, DagWorkflowDefinition>();

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
        const loaded = await loadDagWorkflows(state.workflowsDir, logger);
        store.clear();
        for (const [k, v] of loaded) store.set(k, v);
        logger.info(`Reloaded ${store.size} workflow definition(s)`);
        ctx.messaging.broadcast({ type: "workflow_reload" });
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

      // Initialize data stores with the shared database instance
      initDagRunStore(ctx.db);
      initSignalStore(ctx.db);

      // Load workflow definitions
      state.workflowsDir = path.join(ctx.paths.work, "workflows");
      await mkdir(state.workflowsDir, { recursive: true });

      const loaded = await loadDagWorkflows(state.workflowsDir, logger);
      store.clear();
      for (const [k, v] of loaded) store.set(k, v);
      logger.info(`Loaded ${store.size} workflow definition(s)`);

      // Create the steps queue (declared before coordinatorDeps so cancelJob can reference it).
      const stepsQueue = ctx.queues.create<DagStepJobData>(
        "steps",
        createDagStepProcessor({
          ctx,
          emitEvent: (event: AgentEvent, jobId: string, jobData: DagStepJobData) => {
            ctx.events.emit({
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
          getStepHandler: (type) => ctx.stepTypes.get(type),
        }),
        {
          concurrency: 1,
          removeOnComplete: false,
          removeOnFail: false,
          useLocks: false,
          stallConfig: { stallInterval: 1000 * 60 * 5, maxStalls: 1, gracePeriod: 15000, enabled: true },
        },
      );

      // Build the coordinator dependencies (shared by completion, failure, resume, emit).
      const coordinatorDeps: DagCoordinatorDeps = {
        flowProducer,
        sessionFactory,
        log: logger,
        broadcast: (event) => ctx.messaging.broadcast(event),
        getWorkflowDefinition: (name) => store.get(name),
        cancelJob: async (jobId) => {
          await stepsQueue.cancelJob(jobId);
        },
      };

      // Register the DAG emit step type handler
      ctx.stepTypes.register("emit", createDagEmitHandler({ coordinatorDeps }));

      /**
       * Shared DAG dispatch helper. Dispatches a workflow, broadcasts the
       * `workflow_started` event, and kicks off inline root nodes if any.
       */
      async function dispatchAndAnnounce(
        wf: DagWorkflowDefinition,
        payload: unknown,
      ): Promise<{ workflowRunId: string; jobIds: string[] }> {
        const result = await dispatchDagWorkflow(
          flowProducer,
          wf,
          payload ?? null,
          logger,
          sessionFactory,
          async (runId, rootSlugs) => {
            for (const slug of rootSlugs) {
              await evaluateInlineRoot(runId, slug, coordinatorDeps);
            }
          },
        );

        ctx.messaging.broadcast({
          type: "workflow_started",
          workflowRunId: result.workflowRunId,
          workflowName: wf.name,
          steps: Object.entries(wf.steps).map(([slug, s]) => ({ slug, type: s.type })),
        });

        return result;
      }

      // Register the dispatch function so all extension contexts can use ctx.workflows.dispatch()
      setWorkflowDispatchFn(async (name, payload) => {
        const wf = store.get(name);
        if (!wf) {
          throw new Error(`Workflow not found: ${name}`);
        }
        if (wf.enabled === false) {
          throw new Error(`Workflow is disabled: ${name}`);
        }
        return dispatchAndAnnounce(wf, payload);
      });

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

      // Wire queue events -> DAG coordinator + WebSocket broadcasts
      stepsQueue.onEvent("active", ({ job }) => {
        if (!job) return;
        const d = stepData(job);
        ctx.messaging.broadcast({
          type: "workflow_step_started",
          workflowRunId: d.workflowRunId,
          stepSlug: d.stepSlug,
          jobId: d.id,
        });
      });

      stepsQueue.onEvent("completed", async ({ job }) => {
        if (!job) return;
        const d = stepData(job);
        await handleDagStepCompletion(d.workflowRunId, d.stepSlug, job.returnvalue, d.id, coordinatorDeps);
      });

      stepsQueue.onEvent("failed", async ({ jobId, failedReason, job }) => {
        if (!job) return;
        const d = stepData(job);

        ctx.messaging.broadcast({
          type: "workflow_step_failed",
          workflowRunId: d.workflowRunId,
          stepSlug: d.stepSlug,
          jobId: d.id,
          error: failedReason,
        });

        // Only fail the run permanently once the job is truly failed (not a retry delay)
        if (d.state === "failed") {
          // Collect in-flight jobs to cancel for fail-fast
          const inFlight = runJobs(await stepsQueue.getAllJobs(), d.workflowRunId)
            .filter((s) => s.id !== d.id && (s.state === "active" || s.state === "waiting" || s.state === "delayed"))
            .map((s) => s.id);

          await handleDagStepFailure(d.workflowRunId, d.stepSlug, failedReason, coordinatorDeps, inFlight);

          // Emit domain event for cross-extension consumption (e.g. error-analyzer)
          ctx.events.emit({
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
       * any matching workflows.
       *
       * @param triggerType - The workflow trigger type to match
       * @param slug - The event slug to match against workflow `trigger.ref`
       * @param payload - The trigger payload
       * @param sourceLabel - Human-readable label for log messages
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
              const result = await dispatchAndAnnounce(wf, payload);
              logger.info(`${sourceLabel} "${slug}" triggered workflow "${wf.name}" -> run ${result.workflowRunId}`);
            } catch (err) {
              logger.error(`Failed to dispatch workflow "${wf.name}" for ${sourceLabel.toLowerCase()} "${slug}":`, err);
            }
          }
        }
      }

      ctx.events.on("webhook:received", async (event) => {
        const slug = event.context?.slug as string | undefined;
        if (!slug) return;
        await matchAndDispatch("webhook", slug, event.context?.payload, "Webhook");
      });

      ctx.events.on("filewatcher:detected", async (event) => {
        const slug = event.context?.slug as string | undefined;
        if (!slug) return;
        await matchAndDispatch("filewatcher", slug, event.context, "File watcher");
      });

      ctx.events.on("scheduler:fired", async (event) => {
        const slug = event.context?.slug as string | undefined;
        if (!slug) return;
        await matchAndDispatch("schedule", slug, event.context, "Schedule");
      });

      // --- Routes ---

      // Adapter: wrap ctx.internal.secrets into a TemplateSecretResolver for validation
      const secretResolver: TemplateSecretResolver | undefined = ctx.internal?.secrets
        ? {
            async resolve(name: string, consumer: string) {
              const value = await ctx.internal!.secrets.resolveAs(name, consumer);
              return { value, granted: value !== null, reason: value === null ? "denied or not found" : undefined };
            },
          }
        : undefined;

      ctx.routes.register("GET", "/meta/tools", async () => {
        return Response.json(ctx.tools.names().sort());
      });

      ctx.routes.register("GET", "/meta/skills", async () => {
        return Response.json(ctx.skills.names().sort());
      });

      /**
       * Returns available trigger refs grouped by trigger type.
       */
      ctx.routes.register("GET", "/meta/triggers", async () => {
        const origin = ctx.urls.origin;
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

      ctx.routes.register("GET", "/", async () => {
        const list = await Promise.all(
          [...store.values()].map(async (w) => {
            const allRuns = dagRunStore.getByWorkflowName(w.name);
            let activeRuns = 0;
            let completedRuns = 0;
            let failedRuns = 0;
            for (const run of allRuns) {
              switch (run.status) {
                case "completed":
                  completedRuns++;
                  break;
                case "failed":
                  failedRuns++;
                  break;
                case "running":
                case "waiting-signal":
                  activeRuns++;
                  break;
                default:
                  break;
              }
            }

            const templateWarnings = await validateDagWorkflowTemplates(w, {
              workflowName: w.name,
              secretStore: secretResolver,
            });
            const depWarnings = getDependencyWarnings(w, ctx);

            return {
              name: w.name,
              description: w.description,
              trigger: w.trigger,
              stepCount: Object.keys(w.steps).length,
              enabled: w.enabled ?? true,
              steps: Object.entries(w.steps).map(([slug, s]) => ({ slug, type: s.type })),
              edges: w.edges,
              activeRuns,
              completedRuns,
              failedRuns,
              warnings: [...templateWarnings, ...depWarnings],
            };
          }),
        );
        return Response.json(list);
      });

      ctx.routes.register("GET", "/:name", async (reqCtx) => {
        const name = (reqCtx.params as Record<string, string>).name;
        const wf = store.get(name ?? "");
        if (!wf) return Response.json({ error: "Workflow not found" }, { status: 404 });

        // Build run summaries from the DAG Run Store (authoritative for DAG runs).
        const allRuns = dagRunStore.getByWorkflowName(name!);
        const runs = allRuns
          .map((run) => ({
            runId: run.id,
            status: run.status,
            startedAt: run.createdAt,
            completedAt: run.status === "completed" || run.status === "failed" ? run.updatedAt : undefined,
            steps: Object.entries(run.stepStatuses).map(([slug, status]) => ({
              slug,
              status,
              jobId: run.id,
            })),
          }))
          .sort((a, b) => b.startedAt - a.startedAt)
          .slice(0, 20);

        const templateWarnings = await validateDagWorkflowTemplates(wf, {
          workflowName: wf.name,
          secretStore: secretResolver,
        });
        const depWarnings = getDependencyWarnings(wf, ctx);

        // Build resolved output schemas for frontend autocomplete
        const triggerOutputSchema = resolveTriggerOutputSchema(
          wf.trigger.type,
          wf.trigger.outputSchema as OutputSchema | undefined,
        );
        const stepOutputSchemas: Record<string, OutputSchema> = {};
        for (const [slug, stepDef] of Object.entries(wf.steps)) {
          const schema = (stepDef as { outputSchema?: OutputSchema }).outputSchema;
          if (schema) stepOutputSchemas[slug] = schema;
        }

        return Response.json({
          ...wf,
          runs,
          warnings: [...templateWarnings, ...depWarnings],
          outputSchemas: {
            trigger: triggerOutputSchema ?? null,
            steps: stepOutputSchemas,
          },
        });
      });

      ctx.routes.register("POST", "/run/:name", async (reqCtx) => {
        const name = (reqCtx.params as Record<string, string>).name;
        const wf = store.get(name ?? "");
        if (!wf) return Response.json({ error: "Workflow not found" }, { status: 404 });

        const payload = reqCtx.body ?? null;
        const result = await dispatchAndAnnounce(wf, payload);
        return Response.json({ ok: true, workflowRunId: result.workflowRunId, jobIds: result.jobIds }, { status: 202 });
      });

      ctx.routes.register("GET", "/runs/:runId", async (reqCtx) => {
        const runId = (reqCtx.params as Record<string, string>).runId;
        if (!runId) return Response.json({ error: "Missing runId" }, { status: 400 });

        const run = dagRunStore.get(runId);
        if (!run) return Response.json({ error: "Run not found" }, { status: 404 });

        const wf = store.get(run.workflowName);

        // Active signal (waiting-signal status) for waitFor steps
        let activeSignal: signalStore.SignalRecord | null = null;
        if (run.status === "waiting-signal") {
          const allWaiting = signalStore.getAllWaiting().filter((s) => s.runId === runId);
          activeSignal = allWaiting[0] ?? null;
        }

        // Extract chosenBranch info from step results for CF nodes
        const chosenBranches: Record<string, string> = {};
        for (const [slug, result] of Object.entries(run.stepResults)) {
          if (result && typeof result === "object" && "chosenBranch" in result) {
            chosenBranches[slug] = (result as { chosenBranch: string }).chosenBranch;
          } else if (result && typeof result === "object" && "matched" in result) {
            chosenBranches[slug] = (result as { matched: string }).matched;
          }
        }

        // Map each step slug to the real queue job ID so the UI can fetch that
        // step's logs (via GET /api/jobs/:jobId/logs). The run ID is NOT a job
        // ID; steps that never produced a job (e.g. dead branches, control-flow
        // nodes) simply have no entry and get an empty jobId below.
        const stepJobIds = buildStepJobIdMap(runJobs(await stepsQueue.getAllJobs(), runId));

        const steps = Object.entries(run.stepStatuses).map(([slug, status]) => {
          const stepDef = wf?.steps[slug];
          const entry: {
            slug: string;
            type: string;
            status: string;
            jobId: string;
            waitEvent?: string;
            waitInputSchema?: Record<string, unknown> | null;
          } = {
            slug,
            type: stepDef?.type ?? "unknown",
            status: activeSignal?.stepSlug === slug ? "waiting-signal" : status,
            jobId: stepJobIds.get(slug) ?? "",
          };
          if (activeSignal?.stepSlug === slug) {
            entry.waitEvent = activeSignal.event;
            entry.waitInputSchema = activeSignal.inputSchema as Record<string, unknown> | null;
          }
          return entry;
        });

        return Response.json({
          runId,
          workflowName: run.workflowName,
          status: run.status,
          trigger: wf?.trigger ?? null,
          chosenBranches,
          steps,
        });
      });

      ctx.routes.register("GET", "/runs/:runId/logs", async (reqCtx) => {
        const runId = (reqCtx.params as Record<string, string>).runId;
        if (!runId) return Response.json({ error: "Missing runId" }, { status: 400 });
        const stepJobs = runJobs(await stepsQueue.getAllJobs(), runId);
        if (stepJobs.length === 0) return Response.json({ error: "Run not found" }, { status: 404 });

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

      /**
       * Signal delivery endpoint - resumes a waiting workflow run.
       */
      ctx.routes.register(
        "POST",
        "/runs/:runId/signal/:event",
        async (reqCtx) => {
          const runId = (reqCtx.params as Record<string, string>).runId;
          const event = (reqCtx.params as Record<string, string>).event;
          if (!runId || !event) return Response.json({ error: "Missing runId or event" }, { status: 400 });

          const rawBody = await reqCtx.request.text();
          if (rawBody.length > 1_000_000) {
            return Response.json({ error: "Payload too large" }, { status: 413 });
          }

          let payload: unknown = null;
          if (rawBody.length > 0) {
            try {
              payload = JSON.parse(rawBody);
            } catch {
              return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
            }
          }

          const run = dagRunStore.get(runId);
          if (!run) return Response.json({ error: "Run not found" }, { status: 404 });

          if (run.status !== "waiting-signal") {
            return Response.json(
              { error: `Run is not awaiting a signal (current status: "${run.status}")` },
              { status: 409 },
            );
          }

          const signal = signalStore.getWaiting(runId, event);
          if (!signal) {
            return Response.json({ error: `Run is not awaiting signal "${event}"` }, { status: 409 });
          }

          // Validate payload against inputSchema if defined
          if (signal.inputSchema) {
            const schema = signal.inputSchema as TSchema;
            if (!Value.Check(schema, payload)) {
              const errors = [...Value.Errors(schema, payload)];
              return Response.json(
                { error: "Validation failed", details: errors.map((e) => ({ path: e.path, message: e.message })) },
                { status: 422 },
              );
            }
          }

          // Atomically mark signal received
          signalStore.markReceived(signal.id, payload);
          signalTimers.cancel(signal.id);

          const stillWaiting = signalStore.getWaiting(runId, event);
          if (stillWaiting) {
            return Response.json({ error: "Signal has already been delivered" }, { status: 409 });
          }

          ctx.messaging.broadcast({
            type: "workflow_step_resumed",
            workflowRunId: runId,
            stepSlug: signal.stepSlug,
            signalEvent: event,
          });

          // Resume the run via the DAG coordinator
          resumeWaitForNode(runId, signal.stepSlug, payload, coordinatorDeps).catch((err) => {
            logger.error(`Failed to resume run ${runId} after signal delivery:`, err);
          });

          return Response.json({ accepted: true, runId, event, runStatus: "running" });
        },
        { parse: "none" },
      );

      ctx.routes.register("DELETE", "/runs/:runId", async (reqCtx) => {
        const runId = (reqCtx.params as Record<string, string>).runId;
        if (!runId) return Response.json({ error: "Missing runId" }, { status: 400 });
        const stepJobs = runJobs(await stepsQueue.getAllJobs(), runId);
        const run = dagRunStore.get(runId);
        if (stepJobs.length === 0 && !run) {
          return Response.json({ error: "Run not found" }, { status: 404 });
        }

        const cancelled: string[] = [];
        for (const d of stepJobs) {
          const removed = await stepsQueue.cancelJob(d.id);
          if (removed) cancelled.push(d.id);
        }

        signalStore.deleteByRunIds([runId]);
        dagRunStore.deleteByIds([runId]);

        for (const jobId of cancelled) {
          ctx.messaging.broadcast({ type: "job_removed", jobId });
        }

        logger.info(`Cancelled workflow run ${runId} (${cancelled.length}/${stepJobs.length} jobs removed)`);
        return Response.json({ runId, cancelled, total: stepJobs.length });
      });

      /**
       * Updates an existing workflow definition on disk and reloads the in-memory store.
       */
      ctx.routes.register("PUT", "/:name", async (reqCtx) => {
        const name = (reqCtx.params as Record<string, string>).name;
        const body = reqCtx.body;

        // Validate body against DAG schema
        if (!Value.Check(DagWorkflowDefinitionSchema, body)) {
          const errors = [...Value.Errors(DagWorkflowDefinitionSchema, body)];
          return Response.json(
            { error: "Validation failed", details: errors.map((e) => `${e.path}: ${e.message}`).join(", ") },
            { status: 400 },
          );
        }

        const def = body as DagWorkflowDefinition;

        // Structural DAG validation
        const dagErrors = validateDag(def);
        const cfErrors = validateCfEdges(def);
        const structuralErrors = [...dagErrors, ...cfErrors];
        if (structuralErrors.length > 0) {
          return Response.json(
            { error: "DAG validation failed", details: structuralErrors.map((e) => e.message).join("; ") },
            { status: 400 },
          );
        }

        // Manual triggers must not include a ref
        if (def.trigger.type === "manual" && def.trigger.ref) {
          return Response.json({ error: "Manual triggers do not support a ref value" }, { status: 400 });
        }

        // Non-manual triggers require a ref
        if (def.trigger.type !== "manual" && !def.trigger.ref) {
          return Response.json({ error: `Trigger type "${def.trigger.type}" requires a ref value` }, { status: 400 });
        }

        // Validate that trigger.ref exists for the given trigger type
        if (def.trigger.type !== "manual" && def.trigger.ref) {
          const triggerType = def.trigger.type;
          const ref = def.trigger.ref;
          const origin = ctx.urls.origin;
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
            refExists = true;
          }
          if (!refExists) {
            return Response.json(
              { error: `Trigger ref "${ref}" does not exist for type "${triggerType}"` },
              { status: 400 },
            );
          }
        }

        if (def.name !== name) {
          return Response.json({ error: "Name in body does not match URL parameter" }, { status: 400 });
        }

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

        try {
          await Bun.write(targetFile, JSON.stringify(def, null, 2));
        } catch (err) {
          logger.error(`Failed to write workflow file "${targetFile}":`, err);
          return Response.json({ error: "Failed to write workflow file" }, { status: 500 });
        }

        store.set(def.name, def);
        scheduleReload(ctx);
        return Response.json({ ok: true });
      });

      ctx.routes.register("DELETE", "/:name", async (reqCtx) => {
        const name = (reqCtx.params as Record<string, string>).name;
        const wf = store.get(name ?? "");
        if (!wf) return Response.json({ error: "Workflow not found" }, { status: 404 });

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
        ctx.messaging.broadcast({ type: "workflow_deleted", workflowName: name! });
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
