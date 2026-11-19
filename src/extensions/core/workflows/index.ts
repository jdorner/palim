/**
 * Workflows extension - enables DAG job pipelines defined in JSON5.
 *
 * Exposes:
 * - `GET    /ext/workflows`              - list loaded workflow definitions
 * - `GET    /ext/workflows/:name`        - get a single workflow definition
 * - `GET    /ext/workflows/meta/groups`  - distinct workflow group names (editor suggestions)
 * - `PUT    /ext/workflows/:name`        - update an existing workflow definition
 * - `PATCH  /ext/workflows/:name/group`  - move a workflow to another group (or ungroup it)
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

import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Extension, ExtensionContext, ExtensionManifest, Logger } from "@ext/types";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { WorkflowLoadError } from "@shared/workflows";
import { WORKFLOW_TIMEZONE } from "@src/config";
import { setWorkflowDispatchFn, setWorkflowNamesFn } from "@src/extensions/engine/extensionContext";
import { resolveAmbientUserId } from "@src/utils/fetch";
import { registerTriggerOwnerCounter } from "@src/web/triggerOwnership";
import { registerWorkflowRunHooks } from "@src/web/workflowRunHooks";
import type { FSWatcher } from "chokidar";
import { resolveDispatchTarget, workflowsForTrigger } from "./autoStart";
import { createDagEmitHandler } from "./dagEmitHandler";
import type { DagStepJobData } from "./dagEngine";
import { loadDagWorkflowFiles, loadSingleWorkflow } from "./dagLoader";
import { initDagRunStore } from "./dagRunStore";
import { createDagStepProcessor } from "./dagWorker";
import { readStepDocs } from "./engineStepTypes";
import { countPortalWorkflowsRunAs, createPortalLauncherProvider } from "./portalLaunchers";
import { createReloadScheduler, type ReloadScheduler } from "./reloadScheduler";
import { registerWorkflowRoutes } from "./routes";
import type { DagWorkflowDefinition } from "./schemas";
import { initSignalStore } from "./signalStore";
import { setDefaultTimeZone } from "./templateFunctions";
import { createWorkflowAnalyzer } from "./workflowAnalysis";
import { watchWorkflowDir } from "./workflowDirWatcher";
import { createWorkflowFileIndex, type WorkflowFileIndex } from "./workflowFileIndex";
import { createWorkflowRuns, type WorkflowRuns } from "./workflowRuns";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const manifest = {
  name: "workflows",
  version: "2.15.0",
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
  /** Tracks which file defines which workflow, for single-file reloads (created with the logger). */
  let fileIndex: WorkflowFileIndex;

  /** Loaded DAG workflow definitions, keyed by name. */
  const store = new Map<string, DagWorkflowDefinition>();

  /** Mutable extension state. */
  const state: {
    watcher: FSWatcher | null;
    reloads: ReloadScheduler | null;
    workflowsDir: string;
    runs: WorkflowRuns | null;
    uninstallRunHooks: (() => void) | null;
    uninstallPortal: (() => void) | null;
  } = {
    watcher: null,
    reloads: null,
    workflowsDir: "",
    runs: null,
    uninstallRunHooks: null,
    uninstallPortal: null,
  };

  /** Reloads one workflow file into the store, or removes its workflow when the file is gone, invalid, or disabled. */
  async function reloadFile(filename: string) {
    const filePath = path.join(state.workflowsDir, filename);
    let error: WorkflowLoadError | undefined;
    const definition = (await Bun.file(filePath).exists())
      ? await loadSingleWorkflow(filePath, logger, (e) => {
          error = e;
        })
      : null;
    fileIndex.applyFile(filename, definition, error);
  }

  /** Scans the workflows directory and replaces the store and the load errors with the result. */
  async function scanAll() {
    const errors: WorkflowLoadError[] = [];
    const loaded = await loadDagWorkflowFiles(state.workflowsDir, logger, (e) => errors.push(e));
    fileIndex.replaceAll(loaded, errors);
  }

  /** Reloads all workflow files from disk, replacing the store. */
  async function reloadAll() {
    await scanAll();
    logger.info(`Reloaded ${store.size} workflow definition(s)`);
  }

  return {
    manifest,

    async initialize(ctx: ExtensionContext) {
      logger = ctx.log;
      fileIndex = createWorkflowFileIndex(store, logger);
      setDefaultTimeZone(WORKFLOW_TIMEZONE || null);

      // Initialize data stores with the shared database instance
      initDagRunStore(ctx.db);
      initSignalStore(ctx.db);

      // Load workflow definitions
      state.workflowsDir = path.join(ctx.paths.work, "workflows");
      await mkdir(state.workflowsDir, { recursive: true });

      await scanAll();
      logger.info(`Loaded ${store.size} workflow definition(s)`);

      // The steps queue is handed only to the run lifecycle, which owns its jobs.
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

      const hitl = ctx.internal?.hitl;
      const runs = createWorkflowRuns({
        stepsQueue,
        flowProducer: ctx.queues.getFlowProducer(),
        sessionFactory: { create: (opts) => ctx.sessions.create(opts) },
        log: logger,
        broadcast: (message) => ctx.messaging.broadcast(message),
        emitEvent: (event) => ctx.events.emit(event),
        getWorkflowDefinition: (name) => store.get(name),
        hitl,
      });
      state.runs = runs;
      // The host's queue clean asks the run lifecycle instead of reading the stores.
      state.uninstallRunHooks = registerWorkflowRunHooks(runs);

      // Register the DAG emit step type handler
      ctx.stepTypes.register("emit", {
        ...createDagEmitHandler({ coordinatorDeps: runs.coordinatorDeps }),
        docs: await readStepDocs("emit"),
      });

      // Register the dispatch function so all extension contexts can use ctx.workflows.dispatch()
      setWorkflowDispatchFn(async (name, payload) => {
        const wf = resolveDispatchTarget(store.get(name), name, fileIndex.loadErrorFor(name));
        // Runs started from within a user's job (e.g. a `start-workflow` step or
        // an agent tool) inherit that user as initiator, so they stay scoped to
        // them instead of becoming unowned runs visible to everyone.
        return runs.start(wf, payload, resolveAmbientUserId());
      });

      // Workflows with a `portal` trigger are offered in the portal and run as
      // the operator bound to them on save.
      const portal = ctx.internal?.portal;
      if (portal) {
        const unregisterProvider = portal.registerLauncherProvider(createPortalLauncherProvider(store, runs.start));
        const unregisterCounter = registerTriggerOwnerCounter("portal workflow", (userId) =>
          countPortalWorkflowsRunAs(store, userId),
        );
        state.uninstallPortal = () => {
          unregisterProvider();
          unregisterCounter();
        };
      }

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
        state.watcher = await watchWorkflowDir(
          state.workflowsDir,
          (filename) => {
            logger.debug(`Workflow file changed: ${filename}`);
            state.reloads?.schedule(filename);
          },
          (err) => logger.error("Workflow watcher error:", err),
        );
        logger.info(`Watching ${state.workflowsDir} for workflow changes`);
      } catch (err) {
        logger.warn("Could not start workflow file watcher:", err);
      }

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
        for (const wf of workflowsForTrigger(store.values(), triggerType, slug)) {
          try {
            const result = await runs.start(wf, payload, initiatorUserId);
            logger.info(`${sourceLabel} "${slug}" triggered workflow "${wf.name}" -> run ${result.workflowRunId}`);
          } catch (err) {
            logger.error(`Failed to dispatch workflow "${wf.name}" for ${sourceLabel.toLowerCase()} "${slug}":`, err);
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
        loadErrors: fileIndex,
        workflowsDir: state.workflowsDir,
        runs,
        hitlEnabled: hitl !== undefined,
        scheduleReload: (filename) => state.reloads?.schedule(filename),
        analyzeWorkflow: createWorkflowAnalyzer(ctx, (target) => store.get(target)),
      });
    },

    async shutdown() {
      if (state.watcher) {
        await state.watcher.close();
        state.watcher = null;
      }
      state.reloads?.cancel();
      state.reloads = null;
      state.uninstallRunHooks?.();
      state.uninstallRunHooks = null;
      state.runs?.dispose();
      state.runs = null;
      state.uninstallPortal?.();
      state.uninstallPortal = null;
      store.clear();
    },
  };
}

const defaultInstance = createExtension();
export default defaultInstance;
