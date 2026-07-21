/**
 * Load-time validation for workflow template expressions.
 *
 * Performs a dry-run check of all `{{...}}` placeholders in step fields
 * (prompt, url, body) against the workflow's own structure. Validates:
 *
 * 1. Step slug references exist in the workflow
 * 2. Steps only reference results from earlier steps (no forward references)
 * 3. Expression syntax matches known prefixes (trigger, steps, env, secret)
 * 4. Environment variable names are on the allowlist
 * 5. Secret keys exist in the vault (optional, only if resolver provided)
 *
 * @module
 */

import type { WorkflowDefinition, WorkflowStep } from "./schemas";
import type { TemplateSecretResolver } from "./template";

/**
 * A single template validation warning.
 */
export interface TemplateWarning {
  /** The step slug where the issue was found. */
  stepSlug: string;
  /** The field containing the expression (e.g. "prompt", "url", "body"). */
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

/** Regex matching `{{...}}` template expressions (same as in template.ts). */
const TEMPLATE_PATTERN = /\{\{([^}]+)\}\}/g;

/** Known expression prefixes. */
const KNOWN_PREFIXES = new Set(["trigger", "steps", "env", "secret"]);

/**
 * Default env var allowlist (must stay in sync with template.ts).
 * Re-computes lazily including WORKFLOW_ENV_ALLOWLIST additions.
 */
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
 * Extract all template-bearing fields from a step.
 *
 * @param step - The workflow step definition
 * @returns Array of [fieldName, fieldValue] pairs that may contain templates
 */
function getTemplateFields(step: WorkflowStep): [string, string][] {
  const fields: [string, string][] = [];
  if (step.type === "agent") {
    const prompt = Array.isArray(step.prompt) ? step.prompt.join("\n") : step.prompt;
    fields.push(["prompt", prompt]);
  } else if (step.type === "webhook") {
    fields.push(["url", step.url]);
    if (step.body) fields.push(["body", step.body]);
  }
  return fields;
}

/**
 * Validate all template expressions in a workflow definition.
 *
 * Performs structural checks that can be done at load time without executing
 * the workflow. Returns a list of warnings (empty if everything is valid).
 *
 * @param definition - The validated workflow definition
 * @param options - Optional validation settings (secret store, workflow name)
 * @returns Array of template warnings (empty means valid)
 */
export async function validateWorkflowTemplates(
  definition: WorkflowDefinition,
  options: TemplateValidationOptions = {},
): Promise<TemplateWarning[]> {
  const warnings: TemplateWarning[] = [];
  const { secretStore, workflowName } = options;

  // Build a set of all step slugs and their indices for ordering checks
  const slugIndex = new Map<string, number>();
  for (let i = 0; i < definition.steps.length; i++) {
    slugIndex.set(definition.steps[i]!.slug, i);
  }

  for (let stepIdx = 0; stepIdx < definition.steps.length; stepIdx++) {
    const step = definition.steps[stepIdx]!;
    const fields = getTemplateFields(step);

    for (const [fieldName, fieldValue] of fields) {
      // Reset lastIndex for global regex reuse
      TEMPLATE_PATTERN.lastIndex = 0;

      // Track reported expressions to avoid duplicate warnings for the same placeholder
      const reported = new Set<string>();

      for (let match = TEMPLATE_PATTERN.exec(fieldValue); match !== null; match = TEMPLATE_PATTERN.exec(fieldValue)) {
        const expr = match[1]!.trim();

        // Skip if we already reported this exact expression in this field
        if (reported.has(expr)) continue;
        reported.add(expr);

        const parts = expr.split(".");

        const prefix = parts[0];

        // Check for unknown prefix
        if (!prefix || !KNOWN_PREFIXES.has(prefix)) {
          warnings.push({
            stepSlug: step.slug,
            field: fieldName,
            message: `Unknown expression prefix "${prefix}" in "{{${expr}}}"`,
          });
          continue;
        }

        // Validate trigger expressions
        if (prefix === "trigger") {
          if (parts.length < 2 || parts[1] !== "payload") {
            warnings.push({
              stepSlug: step.slug,
              field: fieldName,
              message: `Invalid trigger expression "{{${expr}}}" - expected "trigger.payload" or "trigger.payload.<path>"`,
            });
          }
          continue;
        }

        // Validate steps expressions
        if (prefix === "steps") {
          if (parts.length < 3) {
            warnings.push({
              stepSlug: step.slug,
              field: fieldName,
              message: `Incomplete steps expression "{{${expr}}}" - expected "steps.<slug>.result[.<path>]"`,
            });
            continue;
          }

          const referencedSlug = parts[1]!;
          const accessor = parts[2];

          // Check slug exists
          if (!slugIndex.has(referencedSlug)) {
            warnings.push({
              stepSlug: step.slug,
              field: fieldName,
              message: `References unknown step slug "${referencedSlug}" in "{{${expr}}}"`,
            });
            continue;
          }

          // Check ordering (no forward references)
          const referencedIdx = slugIndex.get(referencedSlug)!;
          if (referencedIdx >= stepIdx) {
            warnings.push({
              stepSlug: step.slug,
              field: fieldName,
              message: `Forward reference to step "${referencedSlug}" in "{{${expr}}}" - can only reference earlier steps`,
            });
            continue;
          }

          // Check accessor is "result"
          if (accessor !== "result") {
            warnings.push({
              stepSlug: step.slug,
              field: fieldName,
              message: `Invalid step accessor "${accessor}" in "{{${expr}}}" - only "result" is supported`,
            });
          }
          continue;
        }

        // Validate env expressions
        if (prefix === "env") {
          if (parts.length < 2) {
            warnings.push({
              stepSlug: step.slug,
              field: fieldName,
              message: `Incomplete env expression "{{${expr}}}" - expected "env.<VAR_NAME>"`,
            });
            continue;
          }
          const varName = parts.slice(1).join(".");
          if (!getEnvAllowlist().has(varName)) {
            warnings.push({
              stepSlug: step.slug,
              field: fieldName,
              message: `Environment variable "${varName}" is not in the workflow allowlist`,
            });
          }
          continue;
        }

        // Validate secret expressions
        if (prefix === "secret") {
          if (parts.length !== 2 || !parts[1]) {
            warnings.push({
              stepSlug: step.slug,
              field: fieldName,
              message: `Invalid secret expression "{{${expr}}}" - expected "secret.<KEY>"`,
            });
            continue;
          }

          // Optional: check if secret exists in vault
          if (secretStore && workflowName) {
            const secretKey = parts[1];
            const result = await secretStore.resolve(secretKey, `workflow:${workflowName}`);
            if (!result.granted) {
              warnings.push({
                stepSlug: step.slug,
                field: fieldName,
                message: `Secret "${secretKey}" access denied for workflow "${workflowName}": ${result.reason ?? "unknown"}`,
              });
            } else if (result.value === null) {
              warnings.push({
                stepSlug: step.slug,
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

/**
 * Reset the cached env allowlist (for testing purposes).
 */
export function resetEnvAllowlistCache(): void {
  _envAllowlist = undefined;
}
