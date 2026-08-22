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
  _envAllowlist = new Set(["WEB_HOST", "WEB_PORT", "AGENT_WORK_DIR", "NODE_ENV"]);
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

          // For result references, the referenced step must be an ancestor
          // (guaranteed to have completed before this step runs). Config is static.
          if (accessor === "result") {
            const stepAncestors = ancestors.get(slug) ?? new Set();
            if (referencedSlug !== slug && !stepAncestors.has(referencedSlug)) {
              warnings.push({
                stepSlug: slug,
                field: fieldName,
                message: `Reference to step "${referencedSlug}" in "{{${expr}}}" is not an ancestor - its result may not be available`,
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
