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
import type { Extension, ExtensionContext, ExtensionManifest, Logger, OutputSchemaContext } from "@ext/types";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { type OutputSchema, type OutputSchemas, walkSchemaPath } from "@shared/workflows";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { setWorkflowDispatchFn, setWorkflowNamesFn } from "@src/extensions/engine/extensionContext";
import { resolveHandlerOutputSchema } from "@src/extensions/engine/stepTypeSerialization";
import { SANDBOX_TOOL_NAMES } from "@src/tools/file";
import { createInternalFetch, resolveAmbientToken, resolveAmbientUserId } from "@src/utils/fetch";
import type { TemplateVariableResolver } from "@src/variables";
import { extractBearerToken } from "@src/web/auth";
import { requestUserId } from "@src/web/triggerOwnership";
import {
  type DagCoordinatorDeps,
  evaluateInlineRoot,
  handleDagStepCompletion,
  handleDagStepFailure,
  resumeWaitForNode,
} from "./dagCoordinator";
import { createDagEmitHandler } from "./dagEmitHandler";
import { type DagStepJobData, dispatchDagWorkflow, type SessionFactory } from "./dagEngine";
import { loadDagWorkflows, loadSingleWorkflow } from "./dagLoader";
import * as dagRunStore from "./dagRunStore";
import { initDagRunStore } from "./dagRunStore";
import { type TemplateWarning, validateDagWorkflowTemplates } from "./dagTemplateValidation";
import { validateCfEdges, validateDag, validateIteratorPairing } from "./dagValidation";
import { createDagStepProcessor } from "./dagWorker";
import { compileOutputSchema, resolveTriggerOutputSchemaJson } from "./outputSchemaCompiler";
import type { DagWorkflowDefinition, OutputSchemaShorthand } from "./schemas";
import { DagWorkflowDefinitionSchema } from "./schemas";
import * as signalStore from "./signalStore";
import { initSignalStore } from "./signalStore";
import * as signalTimers from "./signalTimers";
import type { TemplateSecretResolver } from "./template";

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
const BUILTIN_STEP_TYPES = new Set(["agent", "if", "case", "iterator", "aggregator", "waitFor", "emit"]);

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
 * The resolved `outputSchemas` payload together with any warnings accumulated
 * while building it (unrecognized type hints, per-step failures).
 */
interface BuildOutputSchemasResult {
  /** Canonical JSON Schema payload for the workflow trigger and steps. */
  outputSchemas: OutputSchemas;
  /** Non-fatal warnings produced during compilation/resolution. */
  warnings: TemplateWarning[];
}

/**
 * Serializes a live TypeBox schema into a plain JSON Schema record.
 *
 * The handler-declared `outputSchema` is a TypeBox `TSchema`; the wire payload
 * requires a plain JSON Schema object. A structural clone via JSON round-trip
 * mirrors the registry's own serialization, so completion and validation see
 * the identical shape the registry ships as `StepTypeInfo.outputSchema`.
 *
 * @param schema - The live TypeBox schema declared by a step-type handler
 * @returns A plain JSON Schema record
 */
function serializeHandlerSchema(schema: TSchema): OutputSchema {
  return JSON.parse(JSON.stringify(schema)) as OutputSchema;
}

/**
 * Builds the canonical `outputSchemas` payload (JSON Schema everywhere) for a
 * DAG workflow, applying the source-precedence rules and isolating per-step
 * failures so a single bad step never aborts the whole build.
 *
 * Per-step precedence (highest wins):
 * 1. A hand-authored Type_Hint_Shorthand `outputSchema` on the step, compiled to
 *    JSON Schema via {@link compileOutputSchema}.
 * 2. The step-type handler's declared `outputSchema` (a live TypeBox schema),
 *    serialized to JSON Schema.
 * 3. Neither: the slug is left absent from `outputSchemas.steps`.
 *
 * Step schemas are resolved lazily and memoized, so a config-derived handler
 * schema can look up other steps' (or the trigger's) schemas through the
 * {@link OutputSchemaContext} it receives. A reference that leads back to a step
 * currently being resolved (a self-reference or a cycle) resolves to `undefined`.
 *
 * The trigger schema is resolved via {@link resolveTriggerOutputSchemaJson},
 * preferring an explicit shorthand over the built-in default and compiling the
 * chosen shorthand to JSON Schema.
 *
 * This function is pure and NEVER throws: each step is wrapped in a try/catch so
 * a failure skips that slug and processing continues, and all warnings are
 * accumulated into the returned array rather than surfaced as exceptions.
 *
 * @param definition - The DAG workflow definition whose schemas are being built
 * @param getHandlerOutputSchema - Resolver returning the handler-declared TypeBox
 *   schema already resolved for THIS step instance, or `undefined` when no handler
 *   (or no schema) exists. Receives the step type, the full step definition, and
 *   the workflow-scoped {@link OutputSchemaContext} so the caller can resolve a
 *   config-derived (function-form) `outputSchema` against the instance's config.
 *   Because the resolution happens in the injected resolver,
 *   {@link buildOutputSchemas} stays agnostic of the static-vs-function distinction.
 * @returns The resolved `outputSchemas` payload and any accumulated warnings
 */
export function buildOutputSchemas(
  definition: DagWorkflowDefinition,
  getHandlerOutputSchema: (
    type: string,
    stepDef: Record<string, unknown>,
    schemaCtx: OutputSchemaContext,
  ) => TSchema | undefined,
): BuildOutputSchemasResult {
  const warnings: TemplateWarning[] = [];

  let trigger: OutputSchema | null = null;
  try {
    trigger = resolveTriggerOutputSchemaJson(
      definition.trigger.type,
      definition.trigger.outputSchema as OutputSchemaShorthand | undefined,
      (message) => {
        warnings.push({ stepSlug: "trigger", field: "outputSchema", message });
      },
    );
  } catch {
    // Trigger resolution is best-effort: fall back to null on any failure.
    trigger = null;
  }

  // Memoized per-step resolution. `null` marks a slug resolved to "no schema".
  const resolvedSteps = new Map<string, OutputSchema | null>();
  const visiting = new Set<string>();

  const schemaCtx: OutputSchemaContext = {
    resolveReferenceSchema(expr: string): TSchema | undefined {
      const parts = expr.trim().split(".");
      let root: OutputSchema | null = null;
      let path: string[];
      if (parts[0] === "trigger" && parts[1] === "payload") {
        root = trigger;
        path = parts.slice(2);
      } else if (parts[0] === "steps" && parts.length >= 3 && parts[2] === "result") {
        root = resolveStep(parts[1]!);
        path = parts.slice(3);
      } else {
        return undefined;
      }
      const walked = walkSchemaPath(root, path);
      return walked.resolved && walked.node ? (walked.node as TSchema) : undefined;
    },
  };

  function resolveStep(slug: string): OutputSchema | null {
    if (resolvedSteps.has(slug)) return resolvedSteps.get(slug)!;
    const stepDef = definition.steps[slug];
    // Unknown slug, self-reference, or cycle: no schema (not memoized for the
    // in-progress slug so its own resolution still completes normally).
    if (!stepDef || visiting.has(slug)) return null;

    visiting.add(slug);
    let schema: OutputSchema | null = null;
    try {
      const handAuthored = (stepDef as { outputSchema?: OutputSchemaShorthand }).outputSchema;
      if (handAuthored) {
        // Precedence 1: hand-authored shorthand wins, compiled to JSON Schema.
        schema = compileOutputSchema(handAuthored, (message) => {
          warnings.push({ stepSlug: slug, field: "outputSchema", message });
        });
      } else {
        // Precedence 2: handler-declared TypeBox schema (static or config-derived),
        // resolved for this instance and serialized to JSON Schema.
        const handlerSchema = getHandlerOutputSchema(
          (stepDef as { type: string }).type,
          stepDef as Record<string, unknown>,
          schemaCtx,
        );
        if (handlerSchema) schema = serializeHandlerSchema(handlerSchema);
        // Precedence 3: neither -> slug absent, no action.
      }
    } catch {
      // Per-step resilience: skip this slug and continue with the rest.
      schema = null;
    } finally {
      visiting.delete(slug);
    }
    resolvedSteps.set(slug, schema);
    return schema;
  }

  const steps: Record<string, OutputSchema> = {};
  for (const slug of Object.keys(definition.steps)) {
    const schema = resolveStep(slug);
    if (schema) steps[slug] = schema;
  }

  return { outputSchemas: { trigger, steps }, warnings };
}

/** Route namespaces of the extensions that own trigger refs (webhooks, file watchers, schedules). */
const TRIGGER_SOURCE_PREFIXES = ["/ext/webhooks", "/ext/filewatcher", "/ext/scheduler"];

/**
 * Builds an internal fetch for looking up trigger refs on behalf of a request.
 *
 * `ctx.fetch` is confined to `/ext/workflows`, so it cannot reach the
 * trigger-owning extensions. This fetch is additionally allowed into their
 * route namespaces and authorizes as the requesting user (falling back to the
 * ambient/system identity when the request carries no bearer token).
 *
 * @param request - The incoming request whose principal the lookups act as.
 * @returns A `fetch`-compatible function confined to trigger-source routes.
 */
function createTriggerSourceFetch(request: Request): typeof globalThis.fetch {
  const token = extractBearerToken(request.headers.get("authorization"));
  return createInternalFetch({
    tokenProvider: () => token || resolveAmbientToken(),
    prefix: "/ext/workflows",
    allowExtraPrefixes: TRIGGER_SOURCE_PREFIXES,
  });
}

/** Trigger types whose `ref` points at an entity owned by another extension. */
type RefTriggerType = "webhook" | "schedule" | "filewatcher";

/**
 * Known trigger refs per trigger type. `null` means the lookup failed (owning
 * extension disabled, unreachable, or access denied), so refs of that type
 * cannot be verified.
 */
export type TriggerRefLookup = Record<RefTriggerType, string[] | null>;

/** Human-readable names of the entities a trigger ref points at. */
const TRIGGER_REF_LABELS: Record<RefTriggerType, string> = {
  webhook: "Webhook",
  schedule: "Schedule",
  filewatcher: "File watcher",
};

/**
 * Looks up the existing trigger refs (webhook slugs, schedule ids, file
 * watcher slugs) on behalf of a request.
 *
 * @param request - The incoming request whose principal the lookups act as.
 * @param origin - Internal server origin to fetch from.
 * @returns The known refs per trigger type (`null` for a failed lookup).
 */
async function fetchTriggerRefs(request: Request, origin: string): Promise<TriggerRefLookup> {
  const triggerFetch = createTriggerSourceFetch(request);
  const lookup = <T>(path: string, key: (item: T) => string): Promise<string[] | null> =>
    triggerFetch(`${origin}${path}`)
      .then((r) => (r.ok ? (r.json() as Promise<T[]>) : null))
      .then((list) => (Array.isArray(list) ? list.map(key).sort() : null))
      .catch(() => null);

  const [webhook, schedule, filewatcher] = await Promise.all([
    lookup<{ slug: string }>("/ext/webhooks", (w) => w.slug),
    lookup<{ id: string }>("/ext/scheduler/schedules", (s) => s.id),
    lookup<{ slug: string }>("/ext/filewatcher", (w) => w.slug),
  ]);
  return { webhook, schedule, filewatcher };
}

/**
 * Produces warnings for a trigger whose `ref` is missing or points at an
 * entity that no longer exists (e.g. a deleted webhook). Warnings use the
 * reserved `__trigger__` step slug so the UI attributes them to the trigger
 * node. Refs whose lookup failed are not reported.
 *
 * @param definition - The DAG workflow definition to check
 * @param refs - Known trigger refs per trigger type
 * @returns Array of trigger warnings (empty if the trigger is valid or unverifiable)
 */
export function getTriggerRefWarnings(definition: DagWorkflowDefinition, refs: TriggerRefLookup): TemplateWarning[] {
  const { type, ref } = definition.trigger;
  if (type === "manual") return [];

  const label = TRIGGER_REF_LABELS[type];
  if (!ref) {
    return [{ stepSlug: "__trigger__", field: "ref", message: `${label} trigger has no ref` }];
  }
  const known = refs[type];
  if (known && !known.includes(ref)) {
    return [{ stepSlug: "__trigger__", field: "ref", message: `${label} "${ref}" does not exist` }];
  }
  return [];
}

/**
 * Produces per-step warnings for dependencies that are not currently available.
 *
 * @param definition - The DAG workflow definition to check
 * @param ctx - Extension context for querying available tools, skills, and step handlers
 * @returns Array of per-step warnings (empty if all dependencies are satisfied)
 */
export function getDependencyWarnings(definition: DagWorkflowDefinition, ctx: ExtensionContext): TemplateWarning[] {
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
        continue;
      }
      // The step type exists: validate its config against the handler's own
      // TypeBox schema. Otherwise a malformed custom step (e.g. a field with
      // the wrong type) passes the generic DagStep schema at write time and
      // only fails when the step actually runs. Mirror the handler's own
      // validation contract: strip the keys the handler ignores (`type`,
      // `slug`, `outputSchema`) and check the remaining config fields.
      const { type: _type, slug: _slug, outputSchema: _os, ...configFields } = stepDef as Record<string, unknown>;
      if (!Value.Check(handler.schema, configFields)) {
        for (const err of Value.Errors(handler.schema, configFields)) {
          const field = err.path ? err.path.replace(/^\//, "").replace(/\//g, ".") : stepDef.type;
          warnings.push({
            stepSlug: slug,
            field: field || "config",
            message: `Invalid "${stepDef.type}" step config: ${err.message}${err.path ? ` (at ${err.path})` : ""}`,
          });
        }
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
  version: "1.1.1",
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
   * Reloads workflow definitions from disk, debounced.
   *
   * If a specific filename is provided, only that workflow is reloaded (or
   * removed from the store if the file no longer exists). Otherwise all
   * workflows are reloaded from disk.
   */
  function scheduleReload(ctx: ExtensionContext, filename?: string) {
    if (state.reloadTimer) clearTimeout(state.reloadTimer);
    state.reloadTimer = setTimeout(async () => {
      state.reloadTimer = null;
      try {
        if (filename) {
          // Single-file reload via shared loader
          const filePath = path.join(state.workflowsDir, filename);
          if (!(await Bun.file(filePath).exists())) {
            // File deleted (possibly via the DELETE route, which already updated the store)
            const name = filename.replace(/\.json5$/, "");
            if (store.delete(name)) logger.info(`Removed workflow "${name}" from store (file deleted)`);
          } else {
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
        } else {
          // Full reload
          const loaded = await loadDagWorkflows(state.workflowsDir, logger);
          store.clear();
          for (const [k, v] of loaded) store.set(k, v);
          logger.info(`Reloaded ${store.size} workflow definition(s)`);
        }
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

      // Watch for file changes and hot-reload
      try {
        state.watcher = watch(state.workflowsDir, (_event, filename) => {
          if (filename?.endsWith(".json5")) {
            logger.debug(`Workflow file changed: ${filename}`);
            scheduleReload(ctx, filename);
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

      // Adapter: wrap ctx.internal.secrets into a TemplateSecretResolver for validation
      const secretResolver: TemplateSecretResolver | undefined = ctx.internal?.secrets
        ? {
            async resolve(name: string, consumer: string) {
              const value = await ctx.internal!.secrets.resolveAs(name, consumer);
              return { value, granted: value !== null, reason: value === null ? "denied or not found" : undefined };
            },
          }
        : undefined;

      // Adapter: wrap ctx.internal.variables into a TemplateVariableResolver for
      // load-time validation (existence checks). Undefined when the variable
      // store is not exposed, in which case var-existence checks are skipped.
      const variableResolver: TemplateVariableResolver | undefined = ctx.internal?.variables
        ? {
            resolve: (key: string) => ctx.internal!.variables.resolve(key),
            has: (key: string) => ctx.internal!.variables.has(key),
          }
        : undefined;

      /**
       * Resolves a workflow's output schemas and collects every advisory warning
       * (trigger refs, templates, step dependencies, iterator pairing, schema
       * compiler). Shared by the list, detail, and draft-analysis routes so the
       * three cannot diverge.
       */
      async function analyzeWorkflow(
        def: DagWorkflowDefinition,
        triggerRefs: TriggerRefLookup,
      ): Promise<{ outputSchemas: OutputSchemas; warnings: TemplateWarning[] }> {
        // Schemas are resolved BEFORE template validation so the validator and
        // the editor share one resolution.
        const { outputSchemas, warnings: schemaWarnings } = buildOutputSchemas(def, (type, stepDef, schemaCtx) =>
          resolveHandlerOutputSchema(ctx.stepTypes.get(type)?.outputSchema, stepDef, schemaCtx),
        );
        const templateWarnings = await validateDagWorkflowTemplates(def, {
          workflowName: def.name,
          secretStore: secretResolver,
          variableStore: variableResolver,
          resolveStepOutputSchema: (slug) => outputSchemas.steps[slug] ?? null,
          resolveTriggerOutputSchema: () => outputSchemas.trigger,
          allowsSelfReference: (type) => ctx.stepTypes.get(type)?.selfReference === true,
        });
        const pairingWarnings: TemplateWarning[] = validateIteratorPairing(def).map((e) => ({
          stepSlug: "",
          field: "pairing",
          message: e.message,
        }));
        return {
          outputSchemas,
          warnings: [
            ...getTriggerRefWarnings(def, triggerRefs),
            ...templateWarnings,
            ...getDependencyWarnings(def, ctx),
            ...pairingWarnings,
            ...schemaWarnings,
          ],
        };
      }

      ctx.routes.register("GET", "/meta/tools", async () => {
        return Response.json(ctx.tools.names().sort());
      });

      ctx.routes.register("GET", "/meta/skills", async () => {
        return Response.json(ctx.skills.names().sort());
      });

      /**
       * Returns read-only metadata for every custom (extension-registered)
       * workflow step type, sorted by type. Backs the `workflow step-types`
       * command so authors can discover step types contributed by external
       * extensions without a static, hand-maintained list.
       *
       * Note: the engine's built-in control-flow/agent step types are not
       * included here (they are not registered through the step-type registry).
       */
      ctx.routes.register("GET", "/meta/step-types", async () => {
        const stepTypes = ctx.stepTypes
          .list()
          .slice()
          .sort((a, b) => a.type.localeCompare(b.type));
        return Response.json(stepTypes);
      });

      /**
       * Validates a workflow definition without persisting it. Returns
       * `{ valid, errors }` where `errors` covers schema, structural (DAG/CF),
       * and per-step custom-step-type config problems.
       *
       * This is the authoritative validation the `workflow write`/`validate`
       * CLI calls before writing, so an invalid custom step config (e.g. a
       * `sandbox-exec` `command` given as an array) is rejected at authoring
       * time rather than surfacing only when the step runs. Custom step config
       * is checked against the registered handler's own TypeBox schema, which
       * the CLI does not have access to locally.
       */
      ctx.routes.register("POST", "/meta/validate", async (reqCtx) => {
        const body = reqCtx.body;
        const errors: string[] = [];

        if (!Value.Check(DagWorkflowDefinitionSchema, body)) {
          for (const e of Value.Errors(DagWorkflowDefinitionSchema, body)) {
            errors.push(`${e.path || "(root)"}: ${e.message}`);
          }
          return Response.json({ valid: false, errors });
        }

        const def = body as DagWorkflowDefinition;
        for (const e of [...validateDag(def), ...validateCfEdges(def)]) {
          errors.push(e.message);
        }

        // Per-step custom step-type config validation (handler schemas live here,
        // not in the CLI). getDependencyWarnings emits these as warnings; treat
        // config/type problems as hard errors for the validate endpoint.
        for (const w of getDependencyWarnings(def, ctx)) {
          errors.push(`step "${w.stepSlug}" (${w.field}): ${w.message}`);
        }

        return Response.json({ valid: errors.length === 0, errors });
      });

      /**
       * Analyzes an unsaved workflow draft for the editor: resolves its output
       * schemas (for template autocomplete) and collects the same advisory
       * warnings the detail route reports for a saved workflow.
       *
       * Returns `{ valid, outputSchemas, warnings, errors }`. A draft that is not
       * yet a valid definition (e.g. a half-filled step) still gets best-effort
       * output schemas so autocomplete keeps working; its schema errors go to
       * `errors` (the editor validates those fields itself) and `warnings` is
       * empty. Never responds with an error status.
       */
      ctx.routes.register("POST", "/meta/analyze", async (reqCtx) => {
        const body = reqCtx.body;
        if (!Value.Check(DagWorkflowDefinitionSchema, body)) {
          const errors = [...Value.Errors(DagWorkflowDefinitionSchema, body)]
            .slice(0, 20)
            .map((e) => `${e.path || "(root)"}: ${e.message}`);
          let outputSchemas: OutputSchemas = { trigger: null, steps: {} };
          const steps = (body as { steps?: unknown } | null)?.steps;
          if (steps !== null && typeof steps === "object") {
            try {
              outputSchemas = buildOutputSchemas(body as DagWorkflowDefinition, (type, stepDef, schemaCtx) =>
                resolveHandlerOutputSchema(ctx.stepTypes.get(type)?.outputSchema, stepDef, schemaCtx),
              ).outputSchemas;
            } catch {
              // Best effort only: keep the empty schemas.
            }
          }
          return Response.json({ valid: false, outputSchemas, warnings: [], errors });
        }
        const triggerRefs = await fetchTriggerRefs(reqCtx.request, ctx.urls.origin);
        return Response.json({
          valid: true,
          ...(await analyzeWorkflow(body as DagWorkflowDefinition, triggerRefs)),
          errors: [],
        });
      });

      /**
       * Returns available trigger refs grouped by trigger type.
       */
      ctx.routes.register("GET", "/meta/triggers", async (reqCtx) => {
        const refs = await fetchTriggerRefs(reqCtx.request, ctx.urls.origin);
        return Response.json({
          webhook: refs.webhook ?? [],
          schedule: refs.schedule ?? [],
          filewatcher: refs.filewatcher ?? [],
        });
      });

      ctx.routes.register("GET", "/", async (reqCtx) => {
        const triggerRefs = await fetchTriggerRefs(reqCtx.request, ctx.urls.origin);
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

            // The list route does not ship outputSchemas to the client, only the
            // warnings, computed exactly as the detail route does.
            const { warnings } = await analyzeWorkflow(w, triggerRefs);

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
              warnings,
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
        // Run and step statuses are persisted directly, including "waiting-signal"
        // for a run/step paused on a waitFor node, so no display derivation is
        // needed here.
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

        const triggerRefs = await fetchTriggerRefs(reqCtx.request, ctx.urls.origin);
        const { outputSchemas, warnings } = await analyzeWorkflow(wf, triggerRefs);

        return Response.json({
          ...wf,
          runs,
          warnings,
          outputSchemas,
        });
      });

      ctx.routes.register("POST", "/run/:name", async (reqCtx) => {
        const name = (reqCtx.params as Record<string, string>).name;
        const wf = store.get(name ?? "");
        if (!wf) return Response.json({ error: "Workflow not found" }, { status: 404 });

        const payload = reqCtx.body ?? null;
        // Record the requester as the run's initiator so the run is owned by
        // (and its steps authorize as) them rather than being ownerless.
        const result = await dispatchAndAnnounce(wf, payload, requestUserId(reqCtx.request));
        return Response.json({ ok: true, workflowRunId: result.workflowRunId, jobIds: result.jobIds }, { status: 202 });
      });

      // Lightweight bulk run-status lookup. Returns one { runId, status }
      // entry per persisted run across ALL workflows in a single request, so
      // the job list can enrich workflow group badges without fanning out one
      // detail request per workflow definition (which previously tripped the
      // rate limiter after a few page loads).
      ctx.routes.register("GET", "/runs", async () => {
        const runs = dagRunStore.getAll().map((run) => ({ runId: run.id, status: run.status }));
        return Response.json(runs);
      });

      ctx.routes.register("GET", "/runs/:runId", async (reqCtx) => {
        const runId = (reqCtx.params as Record<string, string>).runId;
        if (!runId) return Response.json({ error: "Missing runId" }, { status: 400 });

        const run = dagRunStore.get(runId);
        if (!run) return Response.json({ error: "Run not found" }, { status: 404 });

        const wf = store.get(run.workflowName);

        // Waiting signal records keyed by step slug, used to enrich paused
        // waitFor steps with their event name and input schema. A run may have
        // more than one step paused concurrently.
        const waitingSignalsByStep = new Map<string, signalStore.SignalRecord>();
        for (const signal of signalStore.getAllWaiting()) {
          if (signal.runId === runId) waitingSignalsByStep.set(signal.stepSlug, signal);
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
            status,
            jobId: stepJobIds.get(slug) ?? "",
          };
          const signal = waitingSignalsByStep.get(slug);
          if (signal) {
            entry.waitEvent = signal.event;
            entry.waitInputSchema = signal.inputSchema as Record<string, unknown> | null;
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
          if (!run) {
            return Response.json({ error: "Run not found" }, { status: 404 });
          }

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
        const run = dagRunStore.get(runId);
        const stepJobs = runJobs(await stepsQueue.getAllJobs(), runId);
        if (stepJobs.length === 0 && !run) {
          return Response.json({ error: "Run not found" }, { status: 404 });
        }

        // Remove every step job from the queue in one batch. removeJobs handles
        // all states: live jobs (waiting / active / delayed), DLQ jobs, and
        // completed jobs (requeued then removed under a single queue pause so the
        // worker cannot re-run them). This fully purges the run's jobs, including
        // a run parked on a waitFor signal whose step jobs have all completed, so
        // they do not resurface after a restart.
        const cancelled = await stepsQueue.removeJobs(stepJobs.map((d) => d.id));

        signalStore.deleteByRunIds([runId]);
        dagRunStore.deleteByIds([runId]);

        // Broadcast job_removed for EVERY step job of the run so connected clients
        // drop the whole group immediately, regardless of each job's prior state.
        for (const d of stepJobs) {
          ctx.messaging.broadcast({ type: "job_removed", jobId: d.id });
        }

        // Notify workflow views (e.g. the detail page's run list and counts)
        // that the run itself is gone, since it no longer exists in the run store.
        ctx.messaging.broadcast({
          type: "workflow_run_removed",
          workflowRunId: runId,
          workflowName: run?.workflowName,
        });

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
          const triggerFetch = createTriggerSourceFetch(reqCtx.request);
          let refExists = false;
          try {
            if (triggerType === "webhook") {
              const res = await triggerFetch(`${origin}/ext/webhooks/${encodeURIComponent(ref)}`);
              refExists = res.ok;
            } else if (triggerType === "filewatcher") {
              const res = await triggerFetch(`${origin}/ext/filewatcher`);
              if (res.ok) {
                const list = (await res.json()) as { slug: string }[];
                refExists = list.some((w) => w.slug === ref);
              }
            } else if (triggerType === "schedule") {
              const res = await triggerFetch(`${origin}/ext/scheduler/schedules`);
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
