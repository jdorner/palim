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
 * - `POST   /ext/workflows/runs/:runId/rerun` - start a new run of a failed run with its trigger payload
 * - `POST   /ext/workflows/runs/:runId/steps/:slug/signal` - deliver a signal to a waiting step of a run
 * - `POST   /ext/workflows/signals/:signalId` - deliver a signal by signal ID
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
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Extension, ExtensionContext, ExtensionManifest, Logger } from "@ext/types";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { setWorkflowDispatchFn, setWorkflowNamesFn } from "@src/extensions/engine/extensionContext";
import { resolveAmbientUserId } from "@src/utils/fetch";
import {
  type DagCoordinatorDeps,
  evaluateInlineRoot,
  handleDagStepCompletion,
  handleDagStepFailure,
} from "./dagCoordinator";
import { createDagEmitHandler } from "./dagEmitHandler";
import { type DagStepJobData, dispatchDagWorkflow, type SessionFactory } from "./dagEngine";
import { loadDagWorkflows, loadSingleWorkflow } from "./dagLoader";
import { initDagRunStore } from "./dagRunStore";
import { createDagStepProcessor } from "./dagWorker";
import { cancelRunTasks, installHumanTaskSource } from "./humanTaskSource";
import { createReloadScheduler, type ReloadScheduler } from "./reloadScheduler";
import { registerWorkflowRoutes } from "./routes";
import type { DagWorkflowDefinition } from "./schemas";
import { initSignalStore } from "./signalStore";
import * as signalTimers from "./signalTimers";
import { runJobs, stepData } from "./stepJobs";
import { createWorkflowAnalyzer } from "./workflowAnalysis";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const manifest = {
  name: "workflows",
  version: "2.0.2",
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
    reloads: ReloadScheduler | null;
    workflowsDir: string;
    uninstallHumanTasks: (() => void) | null;
  } = {
    watcher: null,
    reloads: null,
    workflowsDir: "",
    uninstallHumanTasks: null,
  };

  /** Reloads one workflow file into the store, or removes it when the file is gone or invalid. */
  async function reloadFile(filename: string) {
    const filePath = path.join(state.workflowsDir, filename);
    if (!(await Bun.file(filePath).exists())) {
      // File deleted (possibly via the DELETE route, which already updated the store)
      const name = filename.replace(/\.json5$/, "");
      if (store.delete(name)) logger.info(`Removed workflow "${name}" from store (file deleted)`);
      return;
    }
    const definition = await loadSingleWorkflow(filePath, logger);
    if (definition) {
      store.set(definition.name, definition);
      logger.info(`Reloaded workflow "${definition.name}" from ${filename}`);
    } else {
      // File was invalid — remove from store
      store.delete(filename.replace(".json5", ""));
      logger.info(`Removed workflow "${filename}" from store`);
    }
  }

  /** Reloads all workflow files from disk, replacing the store. */
  async function reloadAll() {
    const loaded = await loadDagWorkflows(state.workflowsDir, logger);
    store.clear();
    for (const [k, v] of loaded) store.set(k, v);
    logger.info(`Reloaded ${store.size} workflow definition(s)`);
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
      const hitl = ctx.internal?.hitl;
      const coordinatorDeps: DagCoordinatorDeps = {
        flowProducer,
        sessionFactory,
        log: logger,
        broadcast: (event) => {
          // Every failure path announces workflow_failed; a failed run's open
          // human tasks can no longer be answered.
          if (event.type === "workflow_failed") {
            cancelRunTasks(hitl, event.workflowRunId, `Workflow run failed: ${event.error}`);
          }
          ctx.messaging.broadcast(event);
        },
        getWorkflowDefinition: (name) => store.get(name),
        cancelJob: async (jobId) => {
          await stepsQueue.cancelJob(jobId);
        },
        hitl,
      };

      // Answers, cancellations, and timeouts of human tasks drive their runs.
      state.uninstallHumanTasks = hitl
        ? installHumanTaskSource({
            hitl,
            coordinatorDeps,
            log: logger,
            inFlightJobIds: async (runId) =>
              runJobs(await stepsQueue.getAllJobs(), runId)
                .filter((s) => s.state === "active" || s.state === "waiting" || s.state === "delayed")
                .map((s) => s.id),
          })
        : null;

      // Register the DAG emit step type handler
      ctx.stepTypes.register("emit", createDagEmitHandler({ coordinatorDeps }));

      // Timeout timers live in memory: re-arm the ones of runs still parked on a
      // signal from before the restart (elapsed deadlines fire immediately).
      const rearmed = signalTimers.rearmWaiting({ log: logger, broadcast: coordinatorDeps.broadcast });
      if (rearmed > 0) logger.info(`Re-armed ${rearmed} signal timeout(s)`);

      /**
       * Shared DAG dispatch helper. Dispatches a workflow, broadcasts the
       * `workflow_started` event, and kicks off inline root nodes if any.
       */
      async function dispatchAndAnnounce(
        wf: DagWorkflowDefinition,
        payload: unknown,
        initiatorUserId?: string,
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
          initiatorUserId,
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
        // Runs started from within a user's job (e.g. a `start-workflow` step or
        // an agent tool) inherit that user as initiator, so they stay scoped to
        // them instead of becoming unowned runs visible to everyone.
        return dispatchAndAnnounce(wf, payload, resolveAmbientUserId());
      });

      // Expose the loaded workflow names so other extensions (e.g. core-wf-steps)
      // can populate editor dropdowns and validate workflow references. Reads the
      // live in-memory store, so it stays current across hot-reloads.
      setWorkflowNamesFn(() => [...store.keys()]);

      // Watch for file changes and hot-reload (debounced; every changed file in a burst is reloaded)
      state.reloads = createReloadScheduler({
        delayMs: 300,
        reloadFile,
        reloadAll,
        onReloaded: () => ctx.messaging.broadcast({ type: "workflow_reload" }),
        onError: (err) => logger.error("Failed to reload workflows:", err),
      });
      try {
        state.watcher = watch(state.workflowsDir, (_event, filename) => {
          if (filename?.endsWith(".json5")) {
            logger.debug(`Workflow file changed: ${filename}`);
            state.reloads?.schedule(filename);
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
        initiatorUserId?: string,
      ): Promise<void> {
        for (const wf of store.values()) {
          if (wf.trigger.type === triggerType && wf.trigger.ref === slug && (wf.enabled ?? true)) {
            try {
              const result = await dispatchAndAnnounce(wf, payload, initiatorUserId);
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
        const initiatorUserId = event.context?.initiatorUserId as string | undefined;
        await matchAndDispatch("webhook", slug, event.context?.payload, "Webhook", initiatorUserId);
      });

      ctx.events.on("filewatcher:detected", async (event) => {
        const slug = event.context?.slug as string | undefined;
        if (!slug) return;
        const initiatorUserId = event.context?.initiatorUserId as string | undefined;
        await matchAndDispatch("filewatcher", slug, event.context, "File watcher", initiatorUserId);
      });

      ctx.events.on("scheduler:fired", async (event) => {
        const slug = event.context?.slug as string | undefined;
        if (!slug) return;
        const initiatorUserId = event.context?.initiatorUserId as string | undefined;
        await matchAndDispatch("schedule", slug, event.context, "Schedule", initiatorUserId);
      });

      // --- Routes ---

      registerWorkflowRoutes({
        ctx,
        logger,
        store,
        workflowsDir: state.workflowsDir,
        stepsQueue,
        coordinatorDeps,
        hitl,
        dispatchAndAnnounce,
        scheduleReload: () => state.reloads?.schedule(),
        analyzeWorkflow: createWorkflowAnalyzer(ctx),
      });
    },

    async shutdown() {
      if (state.watcher) {
        state.watcher.close();
        state.watcher = null;
      }
      state.reloads?.cancel();
      state.reloads = null;
      signalTimers.cleanup();
      state.uninstallHumanTasks?.();
      state.uninstallHumanTasks = null;
      store.clear();
    },
  };
}

const defaultInstance = createExtension();
export default defaultInstance;
