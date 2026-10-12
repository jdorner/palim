/**
 * Editor metadata routes: tools, skills, step types, validation, draft
 * analysis, trigger refs, and output schema inference.
 *
 * @module
 */

import type { OutputSchemas } from "@shared/workflows";
import { Value } from "@sinclair/typebox/value";
import { resolveHandlerOutputSchema } from "@src/extensions/engine/stepTypeSerialization";
import * as dagRunStore from "../dagRunStore";
import { validateCfEdges, validateDag } from "../dagValidation";
import { inferSchemaFromRuns, type SchemaSampleSource } from "../schemaSample";
import { type DagWorkflowDefinition, DagWorkflowDefinitionSchema } from "../schemas";
import { fetchTriggerRefs } from "../triggerRefs";
import { buildOutputSchemas, getDependencyWarnings } from "../workflowAnalysis";
import type { WorkflowRouteDeps } from "./types";

/**
 * Registers the editor metadata routes (`/meta/*`).
 *
 * @param deps - Shared extension state and services
 */
export function registerMetaRoutes(deps: WorkflowRouteDeps): void {
  const { ctx, store, analyzeWorkflow } = deps;

  ctx.routes.register("GET", "/meta/tools", async () => {
    return Response.json(ctx.tools.names().sort());
  });

  ctx.routes.register("GET", "/meta/skills", async () => {
    return Response.json(ctx.skills.names().sort());
  });

  /** Returns the distinct `group` names of all loaded workflows, sorted (editor suggestions). */
  ctx.routes.register("GET", "/meta/groups", async () => {
    const groups = new Set<string>();
    for (const wf of store.values()) {
      if (wf.group) groups.add(wf.group);
    }
    return Response.json([...groups].sort((a, b) => a.localeCompare(b)));
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

  /**
   * Infers an outputSchema shorthand for the trigger (`?source=trigger`) or a
   * step (`?source=step&slug=<slug>`) from the newest run with a usable
   * sample. Returns only the inferred types, never the sample values.
   */
  ctx.routes.register("GET", "/meta/infer-schema/:name", async (reqCtx) => {
    const name = (reqCtx.params as Record<string, string>).name;
    const wf = store.get(name ?? "");
    if (!wf) return Response.json({ error: "Workflow not found" }, { status: 404 });

    const params = new URL(reqCtx.request.url).searchParams;
    const sourceParam = params.get("source");
    const slug = params.get("slug") ?? "";
    let source: SchemaSampleSource;
    if (sourceParam === "trigger") {
      source = { kind: "trigger" };
    } else if (sourceParam === "step" && wf.steps[slug]) {
      source = { kind: "step", slug };
    } else {
      return Response.json(
        { error: 'Expected "source=trigger" or "source=step&slug=<existing step slug>"' },
        { status: 400 },
      );
    }

    const sample = inferSchemaFromRuns(dagRunStore.getByWorkflowName(name!), source);
    if (!sample) {
      return Response.json({ error: "No run with an object-shaped sample found" }, { status: 404 });
    }
    return Response.json(sample);
  });
}
