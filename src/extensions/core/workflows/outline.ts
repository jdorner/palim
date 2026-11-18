/**
 * Renders the compact text outline of a workflow printed by `workflow outline`
 * and after every editing command: a header line, one line per step in
 * execution order (slug, type, where it leads, key details), and the warnings.
 *
 * Graph facts (order, outgoing edges, terminals) come only from
 * `analyzeWorkflowGraph` in `shared/workflowTopology.ts`.
 *
 * @module
 */

import { analyzeWorkflowGraph, type TopologyEdge } from "@shared/workflowTopology";
import { humanTaskOutcomeIds } from "./humanTask";
import type { DagWorkflowDefinition } from "./schemas";

/** An advisory warning as returned by the workflow API. */
export interface OutlineWarning {
  stepSlug: string;
  field: string;
  message: string;
}

/** Marker for a step or branch that ends the run. */
const END = "(end)";

/**
 * The branch keys a control-flow step declares in its config, in the order
 * shown: `then`/`else` for `if`, the paths plus the `default` key for `case`.
 *
 * @param step - The step definition
 * @returns The declared branch keys (empty for other step types)
 */
function declaredBranches(step: Record<string, unknown>): string[] {
  if (step.type === "if") return ["then", "else"];
  if (step.type === "case") {
    const paths = Array.isArray(step.paths) ? (step.paths as unknown[]).filter((p) => typeof p === "string") : [];
    const keys = paths as string[];
    if (typeof step.default === "string" && !keys.includes(step.default)) keys.push(step.default);
    return keys;
  }
  return [];
}

/**
 * Describes where a step leads: `-> a, b` for plain edges, `key -> target | ...`
 * for branching steps (a declared branch without an edge shows `(end)`), and
 * `(end)` for a step without outgoing edges.
 *
 * @param step - The step definition
 * @param outgoing - The step's outgoing edges
 * @returns The description
 */
function describeLeads(step: Record<string, unknown>, outgoing: readonly TopologyEdge[]): string {
  const declared = declaredBranches(step);
  const branched = outgoing.filter((e) => e.branch);
  if (declared.length === 0 && branched.length === 0) {
    return outgoing.length === 0 ? END : `-> ${outgoing.map((e) => e.to).join(", ")}`;
  }
  const keys = [...declared];
  for (const edge of branched) if (!keys.includes(edge.branch!)) keys.push(edge.branch!);
  const parts = keys.map((key) => {
    const targets = branched.filter((e) => e.branch === key).map((e) => e.to);
    return `${key} -> ${targets.length > 0 ? targets.join(", ") : END}`;
  });
  const plain = outgoing.filter((e) => !e.branch).map((e) => e.to);
  if (plain.length > 0) parts.push(`-> ${plain.join(", ")}`);
  return parts.join(" | ");
}

/**
 * Key details of a step shown after its leads (human tasks only for now):
 * assignees, outcomes, and the timeout behavior.
 *
 * @param step - The step definition
 * @returns The details, or an empty string
 */
function describeDetails(step: Record<string, unknown>): string {
  if (step.type !== "humanTask") return "";
  const parts: string[] = [];
  const assignees = (step.assignees ?? {}) as { roles?: unknown; users?: unknown };
  if (Array.isArray(assignees.roles) && assignees.roles.length > 0) parts.push(`roles: ${assignees.roles.join(", ")}`);
  if (Array.isArray(assignees.users) && assignees.users.length > 0) parts.push(`users: ${assignees.users.join(", ")}`);
  const outcomes = humanTaskOutcomeIds({
    outcomes: Array.isArray(step.outcomes) ? (step.outcomes as { id: string; label: string }[]) : undefined,
  });
  parts.push(`outcomes: ${outcomes.join(", ")}`);
  const fields = (step.form as { properties?: unknown } | undefined)?.properties;
  if (fields && typeof fields === "object") parts.push(`form: ${Object.keys(fields).join(", ")}`);
  if (step.onTimeout === "expire") {
    parts.push(typeof step.timeout === "number" ? "on timeout: expired" : "on timeout: expired (no timeout set)");
  } else if (typeof step.timeout === "number") {
    parts.push("on timeout: fail");
  }
  return parts.join(" · ");
}

/**
 * Describes the trigger, e.g. `filewatcher inbox-ocr` or `manual`.
 *
 * @param trigger - The trigger definition
 * @returns The description
 */
function describeTrigger(trigger: Record<string, unknown>): string {
  return typeof trigger.ref === "string" ? `${trigger.type} ${trigger.ref}` : String(trigger.type);
}

/**
 * Renders the outline of a workflow definition.
 *
 * @param definition - The workflow definition
 * @param warnings - Advisory warnings to list below the steps
 * @returns The outline text
 */
export function renderOutline(definition: DagWorkflowDefinition, warnings: readonly OutlineWarning[] = []): string {
  const trigger = definition.trigger as Record<string, unknown>;
  const schema = trigger.outputSchema;
  const inputs = schema && typeof schema === "object" && !Array.isArray(schema) ? Object.keys(schema) : [];
  const flags = [definition.draft === true ? "draft" : "", definition.enabled === false ? "disabled" : ""].filter(
    Boolean,
  );
  const header = [
    `${definition.name}${flags.length > 0 ? ` (${flags.join(", ")})` : ""}`,
    `trigger: ${describeTrigger(trigger)}`,
    `inputs: ${inputs.length > 0 ? inputs.join(", ") : "none"}`,
  ].join(" · ");

  const topology = analyzeWorkflowGraph(definition.steps, definition.edges);
  const rows = topology.executionOrder().map((slug) => {
    const step = definition.steps[slug] as unknown as Record<string, unknown>;
    return [slug, String(step.type), describeLeads(step, topology.outgoing(slug)), describeDetails(step)];
  });
  const width = (col: number, of = rows) => Math.max(0, ...of.map((r) => r[col]!.length)) + 2;
  // The leads column is padded only as far as the rows with details need, so
  // one long branch list does not push every detail far to the right.
  const widths = [
    width(0),
    width(1),
    width(
      2,
      rows.filter((r) => r[3]),
    ),
  ];
  const lines = rows.map((r) =>
    r
      .map((cell, i) => (i < 3 ? cell.padEnd(widths[i]!) : cell))
      .join("")
      .trimEnd(),
  );

  const out = [header, "", ...lines];
  if (warnings.length > 0) {
    out.push("", "Warnings:");
    for (const w of warnings) {
      const where = [w.stepSlug, w.field].filter(Boolean).join(".");
      out.push(`  ${where ? `${where}: ` : ""}${w.message}`);
    }
  }
  return out.join("\n");
}
