/**
 * Helpers for the `humanTask` workflow node.
 *
 * A `humanTask` node creates a task in the portal (via `ctx.internal.hitl`)
 * and parks its branch on an instance-scoped signal that only the HITL
 * service may deliver. The coordinator registers the node; this module holds
 * the pure parts: template resolution of the task fields, the step result
 * shape, and the built-in output schema used for template validation and
 * autocomplete.
 *
 * @module
 */

import type { HitlApi, HitlTaskRecord } from "@ext/types";
import type { OutputSchema } from "@shared/workflows";
import type { DagHumanTaskStep } from "./schemas";
import { resolveTemplates, type TemplateContext } from "./template";

/** Signal event name of `humanTask` nodes (instance-scoped, never emitted). */
export const HUMAN_TASK_SIGNAL_EVENT = "hitl.task";

/** HITL source kind used for workflow tasks. */
export const WORKFLOW_TASK_SOURCE = "workflow";

/** The result a `humanTask` step produces (its `steps.<slug>.result`). */
export interface HumanTaskStepResult {
  /** The chosen outcome ID, or `expired` when the task timed out with `onTimeout: "expire"`. */
  outcome: string;
  /** Form data (null without a form or when expired). */
  data: unknown;
  /** The comment (null when none was given). */
  comment: string | null;
  /** Who answered (null when expired or the user no longer exists). */
  respondedBy: { id: string; username: string; displayName: string | null } | null;
  /** Answer timestamp (epoch ms). */
  respondedAt: number;
  /** The task ID. */
  taskId: string;
}

/** The task fields after template resolution. */
export interface ResolvedHumanTaskFields {
  title: string;
  body: string;
  context: Record<string, unknown> | null;
  assignees: { users: string[]; roles: string[] };
}

/** Resolves one template string, collecting unresolved expressions. */
async function resolveOne(template: string, ctx: TemplateContext, problems: string[]): Promise<string> {
  const { resolved, warnings } = await resolveTemplates(template, ctx);
  problems.push(...warnings);
  return resolved;
}

/** Resolves templates in every string of a JSON-like value. */
async function resolveDeep(value: unknown, ctx: TemplateContext, problems: string[]): Promise<unknown> {
  if (typeof value === "string") return resolveOne(value, ctx, problems);
  if (Array.isArray(value)) return Promise.all(value.map((v) => resolveDeep(v, ctx, problems)));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = await resolveDeep(v, ctx, problems);
    return out;
  }
  return value;
}

/**
 * Resolves the templated fields of a `humanTask` step.
 *
 * Assignee entries may resolve to comma-separated lists (e.g. from a variable
 * holding several usernames); empty entries are dropped.
 *
 * @param step - The step definition
 * @param ctx - The run's template context
 * @returns The resolved fields
 * @throws Error listing the unresolved expressions, if any
 */
export async function resolveHumanTaskFields(
  step: DagHumanTaskStep,
  ctx: TemplateContext,
): Promise<ResolvedHumanTaskFields> {
  const problems: string[] = [];
  const title = (await resolveOne(step.title, ctx, problems)).trim();
  const body = step.body ? await resolveOne(step.body, ctx, problems) : "";
  const context = step.context ? ((await resolveDeep(step.context, ctx, problems)) as Record<string, unknown>) : null;

  const expand = async (entries: string[] | undefined): Promise<string[]> => {
    const out: string[] = [];
    for (const entry of entries ?? []) {
      for (const part of (await resolveOne(entry, ctx, problems)).split(",")) {
        const trimmed = part.trim();
        if (trimmed) out.push(trimmed);
      }
    }
    return [...new Set(out)];
  };
  const assignees = { users: await expand(step.assignees.users), roles: await expand(step.assignees.roles) };

  if (problems.length > 0) {
    throw new Error(`Unresolved template expressions: ${problems.join("; ")}`);
  }
  return { title, body, context, assignees };
}

/**
 * Builds the step result for a completed task.
 *
 * @param task - The completed task
 * @param hitl - For describing the responding user
 * @returns The step result
 */
export function completedResult(task: HitlTaskRecord, hitl: Pick<HitlApi, "describeUser">): HumanTaskStepResult {
  return {
    outcome: task.outcome ?? "",
    data: task.response ?? null,
    comment: task.comment,
    respondedBy: task.completedBy ? hitl.describeUser(task.completedBy) : null,
    respondedAt: task.completedAt ?? Date.now(),
    taskId: task.id,
  };
}

/**
 * Builds the step result for a task that expired with `onTimeout: "expire"`.
 *
 * @param taskId - The task ID
 * @param at - Expiry timestamp (epoch ms)
 * @returns The step result
 */
export function expiredResult(taskId: string, at: number): HumanTaskStepResult {
  return { outcome: "expired", data: null, comment: null, respondedBy: null, respondedAt: at, taskId };
}

/**
 * The built-in output schema of a `humanTask` step, for template validation
 * and autocomplete. `outcome` enumerates the declared outcomes (plus
 * `expired` with `onTimeout: "expire"`); `data` follows the form schema.
 *
 * @param step - The step definition
 * @returns The JSON Schema of the step result
 */
export function humanTaskOutputSchema(step: DagHumanTaskStep): OutputSchema {
  const outcomeIds = (step.outcomes ?? [{ id: "approve" }, { id: "reject" }]).map((o) => o.id);
  if (step.onTimeout === "expire") outcomeIds.push("expired");
  return {
    type: "object",
    properties: {
      outcome: { type: "string", enum: outcomeIds },
      data: step.form ?? {},
      comment: { type: "string" },
      respondedBy: {
        type: "object",
        properties: {
          id: { type: "string" },
          username: { type: "string" },
          displayName: { type: "string" },
        },
      },
      respondedAt: { type: "number" },
      taskId: { type: "string" },
    },
  } as OutputSchema;
}
