/**
 * Load-time validation for DAG workflow template expressions.
 *
 * Performs a dry-run check of all `{{...}}` placeholders in step fields against
 * the workflow's DAG structure. Validates:
 *
 * 1. Step slug references exist in the workflow
 * 2. Steps only reference results from ancestor steps (no forward/non-ancestor references)
 * 3. Expression syntax matches known prefixes (trigger, steps, env, secret)
 * 4. Environment variable names are on the allowlist
 * 5. Secret keys exist in the vault (optional, only if resolver provided)
 *
 * @module
 */

import { DEFAULT_ENV_ALLOWLIST } from "@shared/workflows";
import type { DagStepDef, DagWorkflowDefinition } from "./schemas";
import type { TemplateSecretResolver } from "./template";

/**
 * A single template validation warning.
 */
export interface TemplateWarning {
  /** The step slug where the issue was found. */
  stepSlug: string;
  /** The field containing the expression (e.g. "prompt", "condition.ref"). */
  field: string;
  /** Human-readable description of the issue. */
  message: string;
}

/**
 * Options for template validation.
 */
export interface TemplateValidationOptions {
  /** Secret resolver for checking key existence. If omitted, secret checks are skipped. */
  secretStore?: TemplateSecretResolver;
  /** The workflow name used as consumer identity for secret resolution. */
  workflowName?: string;
}

/** Regex matching `{{...}}` template expressions. */
const TEMPLATE_PATTERN = /\{\{([^}]+)\}\}/g;

/** Known expression prefixes. */
const KNOWN_PREFIXES = new Set(["trigger", "steps", "env", "secret"]);

let _envAllowlist: Set<string> | undefined;

function getEnvAllowlist(): Set<string> {
  if (_envAllowlist) return _envAllowlist;
  _envAllowlist = new Set(DEFAULT_ENV_ALLOWLIST);
  const extra = process.env.WORKFLOW_ENV_ALLOWLIST;
  if (extra) {
    for (const name of extra.split(",")) {
      const trimmed = name.trim();
      if (trimmed) _envAllowlist.add(trimmed);
    }
  }
  return _envAllowlist;
}

/**
 * Extract all template-bearing fields from a DAG step definition.
 *
 * @param slug - The step slug
 * @param step - The DAG step definition (no slug field)
 * @returns Array of [fieldName, fieldValue] pairs that may contain templates
 */
function getTemplateFields(step: DagStepDef): [string, string][] {
  const fields: [string, string][] = [];
  if (step.type === "agent") {
    const agentStep = step as { prompt: string | string[] };
    const prompt = Array.isArray(agentStep.prompt) ? agentStep.prompt.join("\n") : agentStep.prompt;
    fields.push(["prompt", prompt]);
  } else if (step.type === "if") {
    const ifStep = step as { condition: { ref: string } };
    if (ifStep.condition?.ref) fields.push(["condition.ref", ifStep.condition.ref]);
  } else if (step.type === "case") {
    const caseStep = step as { match: string };
    if (caseStep.match) fields.push(["match", caseStep.match]);
  } else {
    // Custom / emit / waitFor: scan all string-valued config fields
    const { type: _t, outputSchema: _os, ...config } = step as Record<string, unknown>;
    for (const [key, value] of Object.entries(config)) {
      if (typeof value === "string") fields.push([key, value]);
    }
  }
  return fields;
}

/**
 * Computes the set of ancestor slugs for each step in the DAG.
 *
 * An ancestor of step X is any step from which X is reachable following edges.
 * Used to validate that template references point to steps that will have
 * completed before the referencing step runs.
 *
 * @param definition - The DAG workflow definition
 * @returns Map of step slug to set of ancestor slugs
 */
function computeAncestors(definition: DagWorkflowDefinition): Map<string, Set<string>> {
  const directPreds = new Map<string, Set<string>>();
  for (const slug of Object.keys(definition.steps)) {
    directPreds.set(slug, new Set());
  }
  for (const edge of definition.edges) {
    directPreds.get(edge.to)?.add(edge.from);
  }

  const ancestorCache = new Map<string, Set<string>>();

  function resolve(slug: string, visiting: Set<string>): Set<string> {
    const cached = ancestorCache.get(slug);
    if (cached) return cached;
    if (visiting.has(slug)) return new Set(); // cycle guard (shouldn't happen in a valid DAG)

    visiting.add(slug);
    const ancestors = new Set<string>();
    for (const pred of directPreds.get(slug) ?? []) {
      ancestors.add(pred);
      for (const a of resolve(pred, visiting)) ancestors.add(a);
    }
    visiting.delete(slug);
    ancestorCache.set(slug, ancestors);
    return ancestors;
  }

  const result = new Map<string, Set<string>>();
  for (const slug of Object.keys(definition.steps)) {
    result.set(slug, resolve(slug, new Set()));
  }
  return result;
}

/**
 * Computes the dominator set for each step in the DAG.
 *
 * A step D dominates step N if every path from an entry node (a step with no
 * incoming edges) to N passes through D. By convention a step dominates itself.
 *
 * This is stricter than ancestry: an ancestor reachable on only *some* paths
 * (e.g. a step on the `else` branch of an `if`, feeding a join node) is NOT a
 * dominator of that join node. Template `steps.<slug>.result` references are
 * only *guaranteed* to resolve at runtime when the referenced step dominates
 * the referencing step; a non-dominating ancestor lives on a conditional branch
 * and may be skipped (dead branch), leaving its result absent.
 *
 * Uses the classic iterative data-flow formulation:
 *   dom(entry) = {entry}
 *   dom(n)     = {n} + intersection over preds p of dom(p)
 * iterated to a fixpoint. DAGs converge in a single reverse-topological-free
 * pass in practice, but the fixpoint loop is robust regardless of node order.
 *
 * @param definition - The DAG workflow definition
 * @returns Map of step slug to the set of steps that dominate it (including itself)
 */
function computeDominators(definition: DagWorkflowDefinition): Map<string, Set<string>> {
  const allSlugs = Object.keys(definition.steps);
  const preds = new Map<string, Set<string>>();
  for (const slug of allSlugs) preds.set(slug, new Set());
  for (const edge of definition.edges) {
    preds.get(edge.to)?.add(edge.from);
  }

  const entries = allSlugs.filter((slug) => (preds.get(slug)?.size ?? 0) === 0);

  const dom = new Map<string, Set<string>>();
  for (const slug of allSlugs) {
    // Entry nodes are dominated only by themselves; every other node starts
    // pessimistically dominated by all nodes, then is narrowed by intersection.
    dom.set(slug, entries.includes(slug) ? new Set([slug]) : new Set(allSlugs));
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const slug of allSlugs) {
      if (entries.includes(slug)) continue;
      const slugPreds = [...(preds.get(slug) ?? [])];

      // Intersection of the dominator sets of all predecessors.
      let intersection: Set<string> | null = null;
      for (const p of slugPreds) {
        const pDom = dom.get(p)!;
        if (intersection === null) {
          intersection = new Set(pDom);
        } else {
          for (const d of [...intersection]) {
            if (!pDom.has(d)) intersection.delete(d);
          }
        }
      }
      const newDom = intersection ?? new Set<string>();
      newDom.add(slug);

      const prev = dom.get(slug)!;
      if (prev.size !== newDom.size || [...newDom].some((d) => !prev.has(d))) {
        dom.set(slug, newDom);
        changed = true;
      }
    }
  }

  return dom;
}

/**
 * Validate all template expressions in a DAG workflow definition.
 *
 * @param definition - The validated DAG workflow definition
 * @param options - Optional validation settings (secret store, workflow name)
 * @returns Array of template warnings (empty means valid)
 */
export async function validateDagWorkflowTemplates(
  definition: DagWorkflowDefinition,
  options: TemplateValidationOptions = {},
): Promise<TemplateWarning[]> {
  const warnings: TemplateWarning[] = [];
  const { secretStore, workflowName } = options;

  const slugs = new Set(Object.keys(definition.steps));
  const ancestors = computeAncestors(definition);
  const dominators = computeDominators(definition);

  for (const [slug, step] of Object.entries(definition.steps)) {
    const fields = getTemplateFields(step);

    for (const [fieldName, fieldValue] of fields) {
      TEMPLATE_PATTERN.lastIndex = 0;
      const reported = new Set<string>();

      for (let match = TEMPLATE_PATTERN.exec(fieldValue); match !== null; match = TEMPLATE_PATTERN.exec(fieldValue)) {
        const expr = match[1]!.trim();
        if (reported.has(expr)) continue;
        reported.add(expr);

        const parts = expr.split(".");
        const prefix = parts[0];

        if (!prefix || !KNOWN_PREFIXES.has(prefix)) {
          warnings.push({
            stepSlug: slug,
            field: fieldName,
            message: `Unknown expression prefix "${prefix}" in "{{${expr}}}"`,
          });
          continue;
        }

        if (prefix === "trigger") {
          if (parts.length < 2 || parts[1] !== "payload") {
            warnings.push({
              stepSlug: slug,
              field: fieldName,
              message: `Invalid trigger expression "{{${expr}}}" - expected "trigger.payload" or "trigger.payload.<path>"`,
            });
          }
          continue;
        }

        if (prefix === "steps") {
          if (parts.length < 3) {
            warnings.push({
              stepSlug: slug,
              field: fieldName,
              message: `Incomplete steps expression "{{${expr}}}" - expected "steps.<slug>.result[.<path>]"`,
            });
            continue;
          }

          const referencedSlug = parts[1]!;
          const accessor = parts[2];

          if (!slugs.has(referencedSlug)) {
            warnings.push({
              stepSlug: slug,
              field: fieldName,
              message: `References unknown step slug "${referencedSlug}" in "{{${expr}}}"`,
            });
            continue;
          }

          // For result references, the referenced step must run before this one
          // AND be guaranteed to have run. Two distinct failure modes:
          //   - not an ancestor at all: the result is never available here;
          //   - an ancestor but not a dominator: the referenced step sits on a
          //     conditional branch (if/case) that may be skipped, so its result
          //     is only available when that branch is taken. This is exactly the
          //     case that slipped through before and blew up at runtime with
          //     "Unknown step slug in template" on a join node. Config is static
          //     (always present), so this only applies to result references.
          if (accessor === "result" && referencedSlug !== slug) {
            const stepAncestors = ancestors.get(slug) ?? new Set();
            if (!stepAncestors.has(referencedSlug)) {
              warnings.push({
                stepSlug: slug,
                field: fieldName,
                message: `Reference to step "${referencedSlug}" in "{{${expr}}}" is not an ancestor - its result may not be available`,
              });
              continue;
            }
            const stepDominators = dominators.get(slug) ?? new Set();
            if (!stepDominators.has(referencedSlug)) {
              warnings.push({
                stepSlug: slug,
                field: fieldName,
                message: `Reference to step "${referencedSlug}" in "{{${expr}}}" is on a conditional branch that may be skipped - its result may not be available`,
              });
              continue;
            }
          }

          if (accessor !== "result" && accessor !== "config") {
            warnings.push({
              stepSlug: slug,
              field: fieldName,
              message: `Invalid step accessor "${accessor}" in "{{${expr}}}" - only "result" and "config" are supported`,
            });
          }
          continue;
        }

        if (prefix === "env") {
          if (parts.length < 2) {
            warnings.push({
              stepSlug: slug,
              field: fieldName,
              message: `Incomplete env expression "{{${expr}}}" - expected "env.<VAR_NAME>"`,
            });
            continue;
          }
          const varName = parts.slice(1).join(".");
          if (!getEnvAllowlist().has(varName)) {
            warnings.push({
              stepSlug: slug,
              field: fieldName,
              message: `Environment variable "${varName}" is not in the workflow allowlist`,
            });
          }
          continue;
        }

        if (prefix === "secret") {
          if (parts.length !== 2 || !parts[1]) {
            warnings.push({
              stepSlug: slug,
              field: fieldName,
              message: `Invalid secret expression "{{${expr}}}" - expected "secret.<KEY>"`,
            });
            continue;
          }

          if (secretStore && workflowName) {
            const secretKey = parts[1];
            const result = await secretStore.resolve(secretKey, `workflow:${workflowName}`);
            if (!result.granted) {
              warnings.push({
                stepSlug: slug,
                field: fieldName,
                message: `Secret "${secretKey}" access denied for workflow "${workflowName}": ${result.reason ?? "unknown"}`,
              });
            } else if (result.value === null) {
              warnings.push({
                stepSlug: slug,
                field: fieldName,
                message: `Secret "${secretKey}" not found in vault`,
              });
            }
          }
        }
      }
    }
  }

  return warnings;
}
