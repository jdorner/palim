/**
 * Workflow definition routes: list, detail, start a run, update, move to a
 * group, delete.
 *
 * @module
 */

import { unlink } from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { setTopLevelJson5Property } from "@src/utils/json5Edit";
import * as dagRunStore from "../dagRunStore";
import { validateCfEdges, validateDag } from "../dagValidation";
import { clearPortalRunAs, getPortalRunAs, setPortalRunAs } from "../portalRunAs";
import { type DagWorkflowDefinition, DagWorkflowDefinitionSchema, WorkflowGroupSchema } from "../schemas";
import { fetchTriggerRefs, isRefTriggerType } from "../triggerRefs";
import type { WorkflowRouteDeps } from "./types";

/** Body of `PATCH /:name/group`: the new group, or `null` to ungroup. */
const GroupPatchSchema = Type.Object(
  { group: Type.Union([WorkflowGroupSchema, Type.Null()]) },
  { additionalProperties: false },
);

/** Top-level keys a newly added `group` member is placed after, in priority order. */
const GROUP_INSERT_AFTER = ["description", "name"];

/**
 * Finds the JSON5 file in the workflows directory that defines a workflow.
 *
 * @param workflowsDir - Directory holding the workflow JSON5 files
 * @param name - Workflow name (the file's `name` field, not its file name)
 * @returns Absolute path of the file, or `null` if none defines the workflow
 */
async function findWorkflowFile(workflowsDir: string, name: string): Promise<string | null> {
  const glob = new Bun.Glob("*.json5");
  for (const entry of glob.scanSync({ cwd: workflowsDir, absolute: false })) {
    try {
      const content = await Bun.file(path.join(workflowsDir, entry)).text();
      const parsed = Bun.JSON5.parse(content) as Record<string, unknown>;
      if (parsed?.name === name) return path.join(workflowsDir, entry);
    } catch {
      // skip unreadable files
    }
  }
  return null;
}

/**
 * Registers the definition routes (`/`, `/:name`, `/:name/group`, `/run/:name`).
 *
 * @param deps - Shared extension state and services
 */
export function registerDefinitionsRoutes(deps: WorkflowRouteDeps): void {
  const { ctx, logger, store, workflowsDir, dispatchAndAnnounce, scheduleReload, analyzeWorkflow } = deps;

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
          group: w.group,
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

    // The account portal-started runs execute as (shown read-only in the editor).
    const runAsUserId = wf.trigger.type === "portal" ? getPortalRunAs(wf.name) : null;
    const portalRunAs = runAsUserId ? (ctx.internal?.portal?.describeRunAs(runAsUserId) ?? null) : null;

    return Response.json({
      ...wf,
      runs,
      warnings,
      outputSchemas,
      portalRunAs,
    });
  });

  ctx.routes.register("POST", "/run/:name", async (reqCtx) => {
    const name = (reqCtx.params as Record<string, string>).name;
    const wf = store.get(name ?? "");
    if (!wf) return Response.json({ error: "Workflow not found" }, { status: 404 });

    const payload = reqCtx.body ?? null;
    // Record the requester as the run's initiator so the run is owned by
    // (and its steps authorize as) them rather than being ownerless.
    const result = await dispatchAndAnnounce(wf, payload, ctx.auth.requestUserId(reqCtx.request));
    return Response.json({ ok: true, workflowRunId: result.workflowRunId, jobIds: result.jobIds }, { status: 202 });
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

    const triggerType = def.trigger.type;

    // Manual and portal triggers must not include a ref; the others require one.
    if (!isRefTriggerType(triggerType) && def.trigger.ref) {
      return Response.json({ error: `Trigger type "${triggerType}" does not support a ref value` }, { status: 400 });
    }
    if (isRefTriggerType(triggerType) && !def.trigger.ref) {
      return Response.json({ error: `Trigger type "${triggerType}" requires a ref value` }, { status: 400 });
    }
    if (triggerType !== "portal" && def.trigger.portal) {
      return Response.json({ error: "Only portal triggers support a portal configuration" }, { status: 400 });
    }

    // Reject a trigger ref that does not exist. A failed lookup (owning
    // extension disabled, unreachable, or access denied) cannot verify the ref,
    // so the save goes through, as the list and detail warnings treat it.
    if (isRefTriggerType(triggerType) && def.trigger.ref) {
      const known = (await fetchTriggerRefs(reqCtx.request, ctx.urls.origin))[triggerType];
      if (known && !known.includes(def.trigger.ref)) {
        return Response.json(
          { error: `Trigger ref "${def.trigger.ref}" does not exist for type "${def.trigger.type}"` },
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

    const targetFile = await findWorkflowFile(workflowsDir, name!);
    if (!targetFile) return Response.json({ error: "Workflow not found" }, { status: 404 });

    try {
      await Bun.write(targetFile, JSON.stringify(def, null, 2));
      // Saving binds a portal workflow to the editor, like editing a webhook or
      // schedule makes the editor its owner: portal runs execute as them.
      const editorId = ctx.auth.requestUserId(reqCtx.request);
      if (triggerType === "portal" && editorId) setPortalRunAs(name!, editorId);
      else if (triggerType !== "portal") clearPortalRunAs(name!);
    } catch (err) {
      logger.error(`Failed to write workflow file "${targetFile}":`, err);
      return Response.json({ error: "Failed to write workflow file" }, { status: 500 });
    }

    store.set(def.name, def);
    scheduleReload(path.basename(targetFile));
    return Response.json({ ok: true });
  });

  /**
   * Moves a workflow to another group, or out of all groups with `null`.
   *
   * Changes only the `group` member of the JSON5 file and keeps its comments
   * and formatting. Unlike `PUT /:name` it neither re-validates the whole
   * definition (so broken workflows can be regrouped) nor re-binds a portal
   * workflow's run-as account to the caller.
   */
  ctx.routes.register("PATCH", "/:name/group", async (reqCtx) => {
    const name = (reqCtx.params as Record<string, string>).name ?? "";
    const body = reqCtx.body;
    if (!Value.Check(GroupPatchSchema, body)) {
      const errors = [...Value.Errors(GroupPatchSchema, body)];
      return Response.json(
        { error: "Validation failed", details: errors.map((e) => `${e.path}: ${e.message}`).join(", ") },
        { status: 400 },
      );
    }
    const group = body.group ?? undefined;

    const wf = store.get(name);
    if (!wf) return Response.json({ error: "Workflow not found" }, { status: 404 });
    const targetFile = await findWorkflowFile(workflowsDir, name);
    if (!targetFile) return Response.json({ error: "Workflow file not found on disk" }, { status: 404 });

    try {
      const text = await Bun.file(targetFile).text();
      let next = setTopLevelJson5Property(text, "group", group, GROUP_INSERT_AFTER);
      if (next === null) {
        // The text could not be edited in place; rewrite it from the parsed file.
        logger.warn(`Rewriting "${targetFile}" without its comments: in-place group edit failed`);
        const parsed = Bun.JSON5.parse(text) as Record<string, unknown>;
        if (group === undefined) delete parsed.group;
        else parsed.group = group;
        next = JSON.stringify(parsed, null, 2);
      }
      if (next !== text) await Bun.write(targetFile, next);
    } catch (err) {
      logger.error(`Failed to write workflow file "${targetFile}":`, err);
      return Response.json({ error: "Failed to write workflow file" }, { status: 500 });
    }

    const { group: _previous, ...rest } = wf;
    store.set(name, group === undefined ? rest : { ...rest, group });
    scheduleReload(path.basename(targetFile));
    return Response.json({ ok: true, group: group ?? null });
  });

  ctx.routes.register("DELETE", "/:name", async (reqCtx) => {
    const name = (reqCtx.params as Record<string, string>).name;
    const wf = store.get(name ?? "");
    if (!wf) return Response.json({ error: "Workflow not found" }, { status: 404 });

    const targetFile = await findWorkflowFile(workflowsDir, name!);

    if (!targetFile) return Response.json({ error: "Workflow file not found on disk" }, { status: 404 });

    await unlink(targetFile);
    store.delete(name!);
    clearPortalRunAs(name!);
    ctx.messaging.broadcast({ type: "workflow_deleted", workflowName: name! });
    logger.info(`Deleted workflow "${name}" (${targetFile})`);
    return Response.json({ ok: true });
  });
}
