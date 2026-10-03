/**
 * Cross-reference scan for global variable usage in DAG workflow definitions.
 *
 * Scans workflow definitions for `{{var.<KEY>}}` template expressions and
 * reports which workflows reference a given variable key. Used by the global
 * variable DELETE flow to warn before removing a variable that workflows still
 * reference.
 *
 * Field extraction reuses `getTemplateFields` from `dagTemplateValidation.ts`,
 * so it inspects exactly the template-bearing fields the validator checks
 * (agent `prompt`, `if` `condition.ref`, `case` `match`, and every string value
 * nested in a custom step's config). Matching reuses the same `{{...}}` pattern parsing so detection stays
 * aligned with resolution and validation: an expression matches only when it
 * parses to exactly `["var", key]` after trimming, avoiding false positives
 * from `{{var.OTHER}}` or `{{varX...}}`.
 *
 * @module
 */

import { getTemplateFields } from "./dagTemplateValidation";
import type { DagWorkflowDefinition } from "./schemas";

/** Regex matching `{{...}}` template expressions. */
const TEMPLATE_PATTERN = /\{\{([^}]+)\}\}/g;

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
      for (const [, fieldValue] of getTemplateFields(step)) {
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
