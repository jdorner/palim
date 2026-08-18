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
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { setWorkflowDispatchFn } from "@src/extensions/engine/extensionContext";
import { SANDBOX_TOOL_NAMES } from "@src/tools/file";
import { recoverFromCrash } from "./crashRecovery";
import { createEmitHandler } from "./emitHandler";
import type { SessionFactory } from "./engine";
import { dispatchWorkflow } from "./engine";
import { loadWorkflows } from "./loader";
import * as runStore from "./runStore";
import { initRunStore } from "./runStore";
import type { AgentStep, OutputSchema, WorkflowDefinition } from "./schemas";
import { WorkflowDefinitionSchema } from "./schemas";
import { dispatchNextSegment } from "./segmentDispatcher";
import { CONTROL_FLOW_TYPES, segmentWorkflow } from "./segmenter";
import * as signalStore from "./signalStore";
import { initSignalStore } from "./signalStore";
import type { TemplateSecretResolver } from "./template";
import type { TemplateWarning } from "./templateValidation";
import { validateWorkflowTemplates } from "./templateValidation";
import { resolveTriggerOutputSchema } from "./triggerSchemas";
import type { WorkflowStepJobData } from "./types";
import { createStepProcessor, type StepResult } from "./worker";

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
  const availableTools = new Set([...ctx.tools.names(), ...SANDBOX_TOOL_NAMES]);
  const availableSkills = new Set(ctx.skills.names());

  const missingTools = new Set<string>();
  const missingSkills = new Set<string>();

  for (const step of definition.steps) {
    if (step.type !== "agent") continue;

    const agentStep = step as AgentStep;

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

/** Built-in step types handled directly by the workflow engine. */
const BUILTIN_STEP_TYPES = new Set(["agent", "if", "case", "waitFor"]);

/**
 * Produces per-step warnings for dependencies that are not currently available.
 * Checks:
 * - Agent steps: tools and skills that are not registered
 * - Custom step types: whether the extension providing the step handler is active
 *
 * Returns an array compatible with {@link TemplateWarning} so results can be
 * merged with template validation warnings.
 *
 * @param definition - The workflow definition to check
 * @param ctx - Extension context for querying available tools, skills, and step handlers
 * @returns Array of per-step warnings (empty if all dependencies are satisfied)
 */
function getDependencyWarnings(definition: WorkflowDefinition, ctx: ExtensionContext): TemplateWarning[] {
  const availableTools = new Set([...ctx.tools.names(), ...SANDBOX_TOOL_NAMES]);
  const availableSkills = new Set(ctx.skills.names());
  const warnings: TemplateWarning[] = [];

  for (const step of definition.steps) {
    // Check custom (extension-registered) step types are available
    if (!BUILTIN_STEP_TYPES.has(step.type)) {
      const handler = ctx.stepTypes.get(step.type);
      if (!handler) {
        warnings.push({
          stepSlug: step.slug,
          field: "type",
          message: `Step type "${step.type}" is not available (extension disabled or not installed)`,
        });
      }
      continue;
    }

    if (step.type !== "agent") continue;
    const agentStep = step as AgentStep;

    if (agentStep.tools) {
      for (const tool of agentStep.tools) {
        if (!availableTools.has(tool)) {
          warnings.push({
            stepSlug: step.slug,
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
            stepSlug: step.slug,
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
    recoveryCleanup: (() => void) | null;
  } = {
    watcher: null,
    reloadTimer: null,
    workflowsDir: "",
    recoveryCleanup: null,
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
      initRunStore(ctx.db);
      initSignalStore(ctx.db);

      // Recover interrupted runs from previous process crash
      const recovery = recoverFromCrash({
        log: logger,
        broadcast: (event) => ctx.messaging.broadcast(event),
      });
      state.recoveryCleanup = recovery.cleanup;

      // Load workflow definitions
      state.workflowsDir = path.join(ctx.paths.work, "workflows");
      await mkdir(state.workflowsDir, { recursive: true });

      const loaded = await loadWorkflows(state.workflowsDir, logger);
      store.clear();
      for (const [k, v] of loaded) store.set(k, v);
      logger.info(`Loaded ${store.size} workflow definition(s)`);

      // Register the emit step type handler so it's processed by the queue worker
      ctx.stepTypes.register(
        "emit",
        createEmitHandler({
          flowProducer,
          sessionFactory,
          log: logger,
          broadcast: (event) => ctx.messaging.broadcast(event),
          getWorkflowDefinition: (name) => {
            const wf = store.get(name);
            return wf ? { steps: wf.steps } : undefined;
          },
        }),
      );

      // Register the dispatch function so all extension contexts can use ctx.workflows.dispatch()
      setWorkflowDispatchFn(async (name, payload) => {
        const wf = store.get(name);
        if (!wf) {
          throw new Error(`Workflow not found: ${name}`);
        }
        if (wf.enabled === false) {
          throw new Error(`Workflow is disabled: ${name}`);
        }
        const result = await dispatchWorkflow(flowProducer, wf, payload ?? null, logger, sessionFactory);
        ctx.messaging.broadcast({
          type: "workflow_started",
          workflowRunId: result.workflowRunId,
          workflowName: wf.name,
          steps: wf.steps.map((s, i) => ({
            slug: s.slug,
            type: s.type,
            jobId: result.jobIds[i],
          })),
        });

        // When the first segment is a control flow node, the engine returns
        // empty jobIds. Kick off inline evaluation via the segment dispatcher.
        if (result.jobIds.length === 0) {
          const allStepDefs: Record<string, unknown> = {};
          for (const s of wf.steps) allStepDefs[s.slug] = s;
          await dispatchNextSegment(result.workflowRunId, 0, {
            steps: wf.steps,
            allStepDefs,
            flowProducer,
            sessionFactory,
            log: logger,
            broadcast: (event) => ctx.messaging.broadcast(event),
          });
        }

        return result;
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

      // Create the steps queue
      const stepsQueue = ctx.queues.create<WorkflowStepJobData>(
        "steps",
        createStepProcessor({
          ctx,
          flowProducer,
          emitEvent: (event: AgentEvent, jobId: string, jobData: WorkflowStepJobData) => {
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

      // Wire queue events -> WebSocket broadcasts
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

        // Always broadcast workflow_step_completed
        ctx.messaging.broadcast({
          type: "workflow_step_completed",
          workflowRunId: d.workflowRunId,
          stepSlug: d.stepSlug,
          jobId: d.id,
        });

        // Persist step result to Run Store for all runs.
        // The completed event carries `returnvalue` at runtime (from bunqueue's CompletedEvent)
        // even though it's not exposed in ManagedQueue's TypeScript types.
        const jobResult = (job as unknown as { returnvalue?: StepResult }).returnvalue;
        if (jobResult) {
          try {
            runStore.updateStepResult(d.workflowRunId, d.stepSlug, jobResult.value);
          } catch (err) {
            logger.error(`Failed to persist step result for run ${d.workflowRunId}, step ${d.stepSlug}:`, err);
          }
        }

        // Determine if this is a multi-segment workflow
        const wf = store.get(d.workflowName);
        const isMultiSegment = wf ? segmentWorkflow(wf.steps).length > 1 : false;

        if (!isMultiSegment) {
          // Single-segment: preserve existing behavior
          if (d.stepIndex === d.totalSteps - 1) {
            // Mark run as completed in Run Store (best effort)
            try {
              runStore.updateStatus(d.workflowRunId, "completed");
            } catch {
              // best effort
            }
            ctx.messaging.broadcast({ type: "workflow_completed", workflowRunId: d.workflowRunId });
          }
        } else {
          // Multi-segment: check if this step is the last in the current execution segment.

          // Branch step handling: steps dispatched by CF handlers (if/case) carry isBranchStep.
          if (d.isBranchStep && d.resumeStepIndex === undefined && !d.branchContext) {
            // Non-last branch step: chain continues via bunqueue, no segment dispatch needed.
            return;
          }

          if (d.branchContext) {
            // Last step of a branch segment with remaining branch steps (possibly CF).
            // Dispatch the remaining branch steps using the segmentation-aware helper.
            const { remainingSteps, resumeStepIndex: branchResumeIdx } = d.branchContext;
            try {
              const run = runStore.get(d.workflowRunId);
              if (run) {
                const { dispatchBranchSteps } = await import("./segmentDispatcher");
                await dispatchBranchSteps(
                  d.workflowRunId,
                  remainingSteps as import("./schemas").WorkflowStep[],
                  branchResumeIdx,
                  d.stepSlug,
                  run,
                  {
                    steps: wf!.steps,
                    allStepDefs: d.allStepDefs ?? {},
                    flowProducer,
                    sessionFactory,
                    log: logger,
                    broadcast: (event) => ctx.messaging.broadcast(event),
                    getWorkflowDefinition: (name) => {
                      const def = store.get(name);
                      return def ? { steps: def.steps } : undefined;
                    },
                  },
                );
              } else {
                logger.error(`Run ${d.workflowRunId} not found for branch continuation`);
              }
            } catch (err) {
              logger.error(`Failed to dispatch branch continuation for run ${d.workflowRunId}:`, err);
              try {
                runStore.updateStatus(
                  d.workflowRunId,
                  "failed",
                  `Branch continuation failed: ${err instanceof Error ? err.message : String(err)}`,
                );
              } catch {
                // best effort
              }
              ctx.messaging.broadcast({
                type: "workflow_failed",
                workflowRunId: d.workflowRunId,
                failedStep: d.stepSlug,
                error: `Branch continuation failed: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
            return;
          }

          if (d.resumeStepIndex !== undefined) {
            // Last branch step: dispatch next segment at the resume index (step after the CF node).
            try {
              await dispatchNextSegment(d.workflowRunId, d.resumeStepIndex, {
                steps: wf!.steps,
                allStepDefs: d.allStepDefs ?? {},
                flowProducer,
                sessionFactory,
                log: logger,
                broadcast: (event) => ctx.messaging.broadcast(event),
              });
            } catch (err) {
              logger.error(`Failed to dispatch next segment after branch for run ${d.workflowRunId}:`, err);
              try {
                runStore.updateStatus(
                  d.workflowRunId,
                  "failed",
                  `Segment dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
                );
              } catch {
                // best effort
              }
              ctx.messaging.broadcast({
                type: "workflow_failed",
                workflowRunId: d.workflowRunId,
                failedStep: d.stepSlug,
                error: `Segment dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
            return;
          }

          // The next step being a CF node (or beyond the workflow) means the segment boundary is reached.
          const nextStepIndex = d.stepIndex + 1;
          const nextStep = wf!.steps[nextStepIndex];
          const isLastInSegment = !nextStep || CONTROL_FLOW_TYPES.has(nextStep.type);

          if (isLastInSegment) {
            // Dispatch next segment (segment dispatcher handles completion when nextStepIndex >= steps.length)
            try {
              await dispatchNextSegment(d.workflowRunId, nextStepIndex, {
                steps: wf!.steps,
                allStepDefs: d.allStepDefs ?? {},
                flowProducer,
                sessionFactory,
                log: logger,
                broadcast: (event) => ctx.messaging.broadcast(event),
              });
            } catch (err) {
              logger.error(`Failed to dispatch next segment for run ${d.workflowRunId}:`, err);
              // Best-effort: mark run as failed
              try {
                runStore.updateStatus(
                  d.workflowRunId,
                  "failed",
                  `Segment dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
                );
              } catch {
                // best effort
              }
              ctx.messaging.broadcast({
                type: "workflow_failed",
                workflowRunId: d.workflowRunId,
                failedStep: d.stepSlug,
                error: `Segment dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
          }
          // If NOT last in segment, do nothing extra -- the next step in the chain
          // is already queued by FlowProducer.addChain() and will process naturally.
        }
      });
      stepsQueue.onEvent("failed", ({ jobId, failedReason, job }) => {
        if (!job) return;
        const d = stepData(job);
        ctx.messaging.broadcast({
          type: "workflow_step_failed",
          workflowRunId: d.workflowRunId,
          stepSlug: d.stepSlug,
          jobId: d.id,
          error: failedReason,
        });
        ctx.messaging.broadcast({
          type: "workflow_failed",
          workflowRunId: d.workflowRunId,
          failedStep: d.stepSlug,
          error: failedReason,
        });

        // Emit domain event for cross-extension consumption (e.g. error-analyzer)
        // Only emit after the job failed permanently (not just delayed because of retry attempts)
        if (d.state === "failed") {
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
              ctx.messaging.broadcast({
                type: "workflow_started",
                workflowRunId: result.workflowRunId,
                workflowName: wf.name,
                steps: wf.steps.map((s, i) => ({
                  slug: s.slug,
                  type: s.type,
                  jobId: result.jobIds[i],
                })),
              });

              // When the first segment is a control flow node, kick off inline evaluation.
              if (result.jobIds.length === 0) {
                const allStepDefs: Record<string, unknown> = {};
                for (const s of wf.steps) allStepDefs[s.slug] = s;
                await dispatchNextSegment(result.workflowRunId, 0, {
                  steps: wf.steps,
                  allStepDefs,
                  flowProducer,
                  sessionFactory,
                  log: logger,
                  broadcast: (event) => ctx.messaging.broadcast(event),
                });
              }

              logger.info(`${sourceLabel} "${slug}" triggered workflow "${wf.name}" -> run ${result.workflowRunId}`);
            } catch (err) {
              logger.error(`Failed to dispatch workflow "${wf.name}" for ${sourceLabel.toLowerCase()} "${slug}":`, err);
            }
          }
        }
      }

      // --- Subscribe to webhook events for trigger matching ---
      ctx.events.on("webhook:received", async (event) => {
        const slug = event.context?.slug as string | undefined;
        if (!slug) return;
        await matchAndDispatch("webhook", slug, event.context?.payload, "Webhook");
      });

      // --- Subscribe to file watcher events for trigger matching ---
      ctx.events.on("filewatcher:detected", async (event) => {
        const slug = event.context?.slug as string | undefined;
        if (!slug) return;
        await matchAndDispatch("filewatcher", slug, event.context, "File watcher");
      });

      // --- Subscribe to scheduler events for trigger matching ---
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
        const names = ctx.tools.names().sort();
        return Response.json(names);
      });

      ctx.routes.register("GET", "/meta/skills", async () => {
        const names = ctx.skills.names().sort();
        return Response.json(names);
      });

      /**
       * Returns available trigger refs grouped by trigger type.
       * Used by the frontend to populate a dropdown when editing trigger.ref.
       * Queries sibling extensions via their REST APIs to maintain isolation.
       *
       * @returns `{ webhook: string[], schedule: string[], filewatcher: string[] }`
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
            const depWarnings = getDependencyWarnings(w, ctx);

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
        const depWarnings = getDependencyWarnings(wf, ctx);

        // Build resolved output schemas for frontend autocomplete
        const triggerOutputSchema = resolveTriggerOutputSchema(
          wf.trigger.type,
          wf.trigger.outputSchema as OutputSchema | undefined,
        );
        const stepOutputSchemas: Record<string, OutputSchema> = {};
        for (const step of wf.steps) {
          const schema = (step as { outputSchema?: OutputSchema }).outputSchema;
          if (schema) {
            stepOutputSchemas[step.slug] = schema;
          }
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

      /**
       * Creates a new workflow definition on disk and makes it immediately available.
       *
       * @returns `{ ok: true, name: "<name>" }` on success (201), or an error response (400/409/500)
       */
      ctx.routes.register("POST", "/", async (_reqCtx) => {
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

      ctx.routes.register("POST", "/run/:name", async (reqCtx) => {
        const name = (reqCtx.params as Record<string, string>).name;
        const wf = store.get(name ?? "");
        if (!wf) return Response.json({ error: "Workflow not found" }, { status: 404 });

        const payload = reqCtx.body ?? null;
        const result = await dispatchWorkflow(flowProducer, wf, payload, logger, sessionFactory);
        ctx.messaging.broadcast({
          type: "workflow_started",
          workflowRunId: result.workflowRunId,
          workflowName: wf.name,
          steps: wf.steps.map((s, i) => ({
            slug: s.slug,
            type: s.type,
            jobId: result.jobIds[i],
          })),
        });

        // When the first segment is a control flow node, kick off inline evaluation.
        if (result.jobIds.length === 0) {
          const allStepDefs: Record<string, unknown> = {};
          for (const s of wf.steps) allStepDefs[s.slug] = s;
          await dispatchNextSegment(result.workflowRunId, 0, {
            steps: wf.steps,
            allStepDefs,
            flowProducer,
            sessionFactory,
            log: logger,
            broadcast: (event) => ctx.messaging.broadcast(event),
          });
        }

        return Response.json({ ok: true, workflowRunId: result.workflowRunId, jobIds: result.jobIds }, { status: 202 });
      });

      ctx.routes.register("GET", "/runs/:runId", async (reqCtx) => {
        const runId = (reqCtx.params as Record<string, string>).runId;
        if (!runId) return Response.json({ error: "Missing runId" }, { status: 400 });
        const steps = runJobs(await stepsQueue.getAllJobs(), runId);
        if (steps.length === 0) return Response.json({ error: "Run not found" }, { status: 404 });
        const sorted = [...steps].sort((a, b) => a.stepIndex - b.stepIndex);
        const workflowName = sorted[0]!.workflowName;
        const wf = store.get(workflowName);

        // Check Run Store for waiting-signal status and enrich step data
        const run = runStore.get(runId);
        // If run is waiting-signal, find the actual waiting signal record
        let activeSignal: signalStore.SignalRecord | null = null;
        if (run?.status === "waiting-signal") {
          const allWaiting = signalStore.getAllWaiting().filter((s) => s.runId === runId);
          activeSignal = allWaiting[0] ?? null;
        }

        const runStatus =
          run?.status === "waiting-signal" ? "waiting-signal" : buildRunStatus(sorted.map((s) => s.state));

        return Response.json({
          runId,
          workflowName,
          status: runStatus,
          trigger: wf?.trigger ?? null,
          steps: sorted.map((d) => {
            // Override status for the waitFor step that is currently waiting for a signal
            if (activeSignal && d.stepSlug === activeSignal.stepSlug) {
              return {
                slug: d.stepSlug,
                type: d.stepDef.type,
                status: "waiting-signal",
                jobId: d.id,
                waitEvent: activeSignal.event,
                waitInputSchema: activeSignal.inputSchema,
              };
            }
            return {
              slug: d.stepSlug,
              type: d.stepDef.type,
              status: d.state,
              jobId: d.id,
            };
          }),
        });
      });

      ctx.routes.register("GET", "/runs/:runId/logs", async (reqCtx) => {
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

      ctx.routes.register("POST", "/runs/:runId/retry", async (reqCtx) => {
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

        ctx.messaging.broadcast({
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

      /**
       * Signal delivery endpoint - resumes a waiting workflow run.
       *
       * Validates: run exists, run is waiting-signal for the specified event,
       * payload size <= 1MB, inputSchema validation (if defined).
       * Atomically marks signal received, stores payload, transitions run
       * to running, dispatches next segment, and broadcasts resumed event.
       *
       * @returns `{ accepted: true, runId, event, runStatus: "running" }` on success (200)
       */
      ctx.routes.register(
        "POST",
        "/runs/:runId/signal/:event",
        async (reqCtx) => {
          const runId = (reqCtx.params as Record<string, string>).runId;
          const event = (reqCtx.params as Record<string, string>).event;
          if (!runId || !event) return Response.json({ error: "Missing runId or event" }, { status: 400 });

          // Read raw body and enforce 1MB size limit (Requirement 5.8)
          const rawBody = await reqCtx.request.text();
          if (rawBody.length > 1_000_000) {
            return Response.json({ error: "Payload too large" }, { status: 413 });
          }

          // Parse JSON payload
          let payload: unknown = null;
          if (rawBody.length > 0) {
            try {
              payload = JSON.parse(rawBody);
            } catch {
              return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
            }
          }

          // Check run exists (Requirement 6.3)
          const run = runStore.get(runId);
          if (!run) return Response.json({ error: "Run not found" }, { status: 404 });

          // Check run is in waiting-signal status (Requirement 6.4)
          if (run.status !== "waiting-signal") {
            return Response.json(
              { error: `Run is not awaiting a signal (current status: "${run.status}")` },
              { status: 409 },
            );
          }

          // Check a waiting signal record exists for this event (Requirement 5.5, 6.4)
          const signal = signalStore.getWaiting(runId, event);
          if (!signal) {
            return Response.json({ error: `Run is not awaiting signal "${event}"` }, { status: 409 });
          }

          // Validate payload against inputSchema if defined (Requirement 5.4, 6.5)
          if (signal.inputSchema) {
            const schema = signal.inputSchema as TSchema;
            if (!Value.Check(schema, payload)) {
              const errors = [...Value.Errors(schema, payload)];
              return Response.json(
                {
                  error: "Validation failed",
                  details: errors.map((e) => ({ path: e.path, message: e.message })),
                },
                { status: 422 },
              );
            }
          }

          // Atomically mark signal as received (Requirement 5.2, 6.2)
          signalStore.markReceived(signal.id, payload);

          // Verify the mark succeeded (race protection)
          const stillWaiting = signalStore.getWaiting(runId, event);
          if (stillWaiting) {
            // The mark did not take effect (race condition or concurrent delivery)
            return Response.json({ error: "Signal has already been delivered" }, { status: 409 });
          }

          // Store payload as the waitFor step result in Run Store (Requirement 2.6, 6.7)
          try {
            runStore.updateStepResult(runId, signal.stepSlug, payload);
          } catch (err) {
            logger.error(`Failed to store signal payload for run ${runId}, step ${signal.stepSlug}:`, err);
            return Response.json({ error: "Internal error" }, { status: 500 });
          }

          // Transition run status to running (Requirement 2.6)
          try {
            runStore.updateStatus(runId, "running");
          } catch (err) {
            logger.error(`Failed to transition run ${runId} to running:`, err);
            return Response.json({ error: "Internal error" }, { status: 500 });
          }

          // Broadcast workflow_step_resumed (Requirement 10.2)
          ctx.messaging.broadcast({
            type: "workflow_step_resumed",
            workflowRunId: runId,
            stepSlug: signal.stepSlug,
            signalEvent: event,
          });

          // Dispatch next segment asynchronously (Requirement 6.7)
          const wf = store.get(run.workflowName);
          if (wf) {
            // Check for branch continuation (waitFor was inside a branch)
            const branchCont = run.stepResults.__branchContinuation as
              | { remainingSteps: import("./schemas").WorkflowStep[]; resumeStepIndex: number }
              | undefined;

            if (branchCont && branchCont.remainingSteps.length > 0) {
              // Clear the branch continuation marker
              try {
                runStore.updateStepResult(runId, "__branchContinuation", null);
              } catch {
                // best effort
              }

              // Resume with remaining branch steps
              const { dispatchBranchSteps } = await import("./segmentDispatcher");
              const updatedRun = runStore.get(runId);
              if (updatedRun) {
                dispatchBranchSteps(
                  runId,
                  branchCont.remainingSteps,
                  branchCont.resumeStepIndex,
                  signal.stepSlug,
                  updatedRun,
                  {
                    steps: wf.steps,
                    allStepDefs: Object.fromEntries(wf.steps.map((s) => [s.slug, s])),
                    flowProducer,
                    sessionFactory,
                    log: logger,
                    broadcast: (evt) => ctx.messaging.broadcast(evt),
                    getWorkflowDefinition: (name) => {
                      const def = store.get(name);
                      return def ? { steps: def.steps } : undefined;
                    },
                  },
                ).catch((err) => {
                  logger.error(`Failed to dispatch branch continuation after signal for run ${runId}:`, err);
                  try {
                    runStore.updateStatus(
                      runId,
                      "failed",
                      `Branch continuation failed: ${err instanceof Error ? err.message : String(err)}`,
                    );
                  } catch {
                    /* best effort */
                  }
                  ctx.messaging.broadcast({
                    type: "workflow_failed",
                    workflowRunId: runId,
                    failedStep: signal.stepSlug,
                    error: `Branch continuation failed: ${err instanceof Error ? err.message : String(err)}`,
                  });
                });
              }
            } else {
              // Normal main-flow resume
              const nextStepIndex = run.currentStepIndex + 1;
              dispatchNextSegment(runId, nextStepIndex, {
                steps: wf.steps,
                allStepDefs: Object.fromEntries(wf.steps.map((s) => [s.slug, s])),
                flowProducer,
                sessionFactory,
                log: logger,
                broadcast: (evt) => ctx.messaging.broadcast(evt),
              }).catch((err) => {
                logger.error(`Failed to dispatch next segment after signal delivery for run ${runId}:`, err);
                try {
                  runStore.updateStatus(
                    runId,
                    "failed",
                    `Segment dispatch failed after signal: ${err instanceof Error ? err.message : String(err)}`,
                  );
                } catch {
                  // best effort
                }
                ctx.messaging.broadcast({
                  type: "workflow_failed",
                  workflowRunId: runId,
                  failedStep: signal.stepSlug,
                  error: `Segment dispatch failed after signal: ${err instanceof Error ? err.message : String(err)}`,
                });
              });
            }
          } else {
            // Workflow definition no longer loaded - fail the run
            logger.error(`Workflow definition "${run.workflowName}" not found for signal delivery on run ${runId}`);
            runStore.updateStatus(runId, "failed", `Workflow definition "${run.workflowName}" not found`);
            ctx.messaging.broadcast({
              type: "workflow_failed",
              workflowRunId: runId,
              failedStep: signal.stepSlug,
              error: `Workflow definition "${run.workflowName}" not found`,
            });
          }

          return Response.json({ accepted: true, runId, event, runStatus: "running" });
        },
        { parse: "none" },
      );

      ctx.routes.register("DELETE", "/runs/:runId", async (reqCtx) => {
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
          ctx.messaging.broadcast({ type: "job_removed", jobId });
        }

        logger.info(`Cancelled workflow run ${runId} (${cancelled.length}/${stepJobs.length} jobs removed)`);
        return Response.json({ runId, cancelled, total: stepJobs.length });
      });

      /**
       * Updates an existing workflow definition on disk and reloads the in-memory store.
       *
       * @returns `{ ok: true }` on success, or an error response (400/404/500)
       */
      ctx.routes.register("PUT", "/:name", async (reqCtx) => {
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

      ctx.routes.register("DELETE", "/:name", async (reqCtx) => {
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
        ctx.messaging.broadcast({ type: "workflow_deleted", workflowName: name! });
        logger.info(`Deleted workflow "${name}" (${targetFile})`);
        return Response.json({ ok: true });
      });
    },

    async shutdown() {
      if (state.recoveryCleanup) {
        state.recoveryCleanup();
        state.recoveryCleanup = null;
      }
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
