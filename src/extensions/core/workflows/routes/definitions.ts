/**
 * Workflow definition routes: list, detail, start a run, update, delete.
 *
 * @module
 */

import { unlink } from "node:fs/promises";
import path from "node:path";
import { Value } from "@sinclair/typebox/value";
import { requestUserId } from "@src/web/triggerOwnership";
import * as dagRunStore from "../dagRunStore";
import { validateCfEdges, validateDag } from "../dagValidation";
import { type DagWorkflowDefinition, DagWorkflowDefinitionSchema } from "../schemas";
import { createTriggerSourceFetch, fetchTriggerRefs } from "../triggerRefs";
import type { WorkflowRouteDeps } from "./types";

/**
 * Registers the definition routes (`/`, `/:name`, `/run/:name`).
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
    for (const entry of glob.scanSync({ cwd: workflowsDir, absolute: false })) {
      try {
        const content = await Bun.file(path.join(workflowsDir, entry)).text();
        const parsed = Bun.JSON5.parse(content) as Record<string, unknown>;
        if (parsed?.name === name) {
          targetFile = path.join(workflowsDir, entry);
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
    scheduleReload();
    return Response.json({ ok: true });
  });

  ctx.routes.register("DELETE", "/:name", async (reqCtx) => {
    const name = (reqCtx.params as Record<string, string>).name;
    const wf = store.get(name ?? "");
    if (!wf) return Response.json({ error: "Workflow not found" }, { status: 404 });

    const glob = new Bun.Glob("*.json5");
    let targetFile: string | null = null;
    for (const entry of glob.scanSync({ cwd: workflowsDir, absolute: false })) {
      try {
        const content = await Bun.file(path.join(workflowsDir, entry)).text();
        const parsed = Bun.JSON5.parse(content) as Record<string, unknown>;
        if (parsed?.name === name) {
          targetFile = path.join(workflowsDir, entry);
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
}
