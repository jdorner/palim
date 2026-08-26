/**
 * Cross-reference scan for global variable usage in DAG workflow definitions.
 *
 * Scans workflow definitions for `{{var.<KEY>}}` template expressions and
 * reports which workflows reference a given variable key. Used by the global
 * variable DELETE flow to warn before removing a variable that workflows still
 * reference.
 *
 * The field-extraction approach mirrors the one used by
 * `dagTemplateValidation.ts` (`getTemplateFields`): it inspects the same
 * template-bearing fields the engine would resolve (agent `prompt`, `if`
 * `condition.ref`, `case` `match`, and every string-valued custom step config
 * field). Matching reuses the same `{{...}}` pattern parsing so detection stays
 * aligned with resolution and validation: an expression matches only when it
 * parses to exactly `["var", key]` after trimming, avoiding false positives
 * from `{{var.OTHER}}` or `{{varX...}}`.
 *
 * @module
 */

import type { DagStepDef, DagWorkflowDefinition } from "./schemas";

/** Regex matching `{{...}}` template expressions. */
const TEMPLATE_PATTERN = /\{\{([^}]+)\}\}/g;

/**
 * Extract all template-bearing field values from a DAG step definition.
 *
 * Mirrors the extraction used by the load-time template validator so that a
 * reference is detected in exactly the fields the engine would resolve.
 *
 * @param step - The DAG step definition (slug is the map key, not a field here)
 * @returns The field string values that may contain template expressions
 */
function getTemplateFieldValues(step: DagStepDef): string[] {
  const values: string[] = [];
  if (step.type === "agent") {
    const agentStep = step as { prompt: string | string[] };
    const prompt = Array.isArray(agentStep.prompt) ? agentStep.prompt.join("\n") : agentStep.prompt;
    values.push(prompt);
  } else if (step.type === "if") {
    const ifStep = step as { condition: { ref: string } };
    if (ifStep.condition?.ref) values.push(ifStep.condition.ref);
  } else if (step.type === "case") {
    const caseStep = step as { match: string };
    if (caseStep.match) values.push(caseStep.match);
  } else {
    // Custom / emit / waitFor: scan all string-valued config fields
    const { type: _t, outputSchema: _os, ...config } = step as Record<string, unknown>;
    for (const value of Object.values(config)) {
      if (typeof value === "string") values.push(value);
    }
  }
  return values;
}

/**
 * Report whether a field string contains a `{{var.<key>}}` reference for the
 * given key.
 *
 * A match requires the expression to parse to exactly `["var", key]` after
 * trimming, so `{{var.OTHER}}` and `{{varX.KEY}}` never match.
 *
 * @param fieldValue - The field string to scan
 * @param key - The variable key to look for
 * @returns True when at least one matching expression is present
 */
function fieldReferencesVariable(fieldValue: string, key: string): boolean {
  TEMPLATE_PATTERN.lastIndex = 0;
  for (let match = TEMPLATE_PATTERN.exec(fieldValue); match !== null; match = TEMPLATE_PATTERN.exec(fieldValue)) {
    const parts = match[1]!.trim().split(".");
    if (parts.length === 2 && parts[0] === "var" && parts[1] === key) {
      return true;
    }
  }
  return false;
}

/**
 * Find workflow definitions that reference a given variable key via
 * `{{var.KEY}}`.
 *
 * @param definitions - The loaded DAG workflow definitions to scan
 * @param key - The variable key to search for
 * @returns The names of workflows containing at least one matching `{{var.KEY}}`
 *   expression, in the order the definitions were iterated (deduplicated)
 */
export function findWorkflowsReferencingVariable(definitions: Iterable<DagWorkflowDefinition>, key: string): string[] {
  const referencing: string[] = [];
  const seen = new Set<string>();

  for (const definition of definitions) {
    if (seen.has(definition.name)) continue;

    let matched = false;
    for (const step of Object.values(definition.steps)) {
      for (const fieldValue of getTemplateFieldValues(step)) {
        if (fieldReferencesVariable(fieldValue, key)) {
          matched = true;
          break;
        }
      }
      if (matched) break;
    }

    if (matched) {
      referencing.push(definition.name);
      seen.add(definition.name);
    }
  }

  return referencing;
}
