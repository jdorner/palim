/**
 * Template resolution engine for workflow step fields.
 *
 * Resolves `{{trigger.payload}}`, `{{steps.<slug>.result}}`,
 * `{{env.<VAR>}}`, and `{{secret.<KEY>}}` expressions with dot-path traversal.
 *
 * Environment variable access is restricted to an explicit allowlist to prevent
 * template injection attacks where attacker-controlled data (webhook payloads,
 * LLM outputs) can exfiltrate sensitive env vars through chained step results.
 */

/**
 * Minimal interface for secret resolution within templates.
 */
export interface TemplateSecretResolver {
  resolve(name: string, consumer: string): Promise<{ value: string | null; granted: boolean; reason?: string }>;
}

/**
 * Environment variables that workflow templates are allowed to read.
 *
 * This allowlist prevents template injection attacks: if attacker-controlled
 * data (e.g. a webhook payload) is echoed by the LLM into a step result, and
 * a subsequent step uses `{{steps.<slug>.result}}`, the template engine would
 * resolve any `{{env.*}}` expressions found in that result. Without an
 * allowlist, this enables exfiltration of sensitive env vars like API keys.
 *
 * To add new vars, append them here or set the `WORKFLOW_ENV_ALLOWLIST`
 * environment variable to a comma-separated list of additional var names.
 */
const DEFAULT_ENV_ALLOWLIST = new Set<string>(["WEB_HOST", "WEB_PORT", "AGENT_WORK_DIR", "NODE_ENV"]);

/** Lazily computed full allowlist (defaults + user-configured additions). */
let _envAllowlist: Set<string> | undefined;

/**
 * Returns the effective env var allowlist for workflow templates.
 * Merges the built-in defaults with any additional names specified in
 * `WORKFLOW_ENV_ALLOWLIST` (comma-separated).
 */
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

/** Context available during template resolution. */
export interface TemplateContext {
  /** The trigger payload (available to all steps). */
  triggerPayload?: unknown;
  /** Results from previously completed steps, keyed by slug. */
  stepResults: Record<string, unknown>;
  /** Step definitions (configs) from the workflow, keyed by slug. Available for cross-step config references. */
  stepConfigs?: Record<string, unknown>;
  /** The workflow name (used as consumer identity for secret resolution). */
  workflowName?: string;
  /** The secret resolver instance (optional - secret templates ignored if not provided). */
  secretStore?: TemplateSecretResolver;
}

/**
 * Traverse an object by dot-separated path segments.
 *
 * @param obj - The root object to traverse
 * @param segments - Path segments (e.g. ["result", "valid"])
 * @returns The resolved value, or undefined if the path is invalid
 */
function traversePath(obj: unknown, segments: string[]): unknown {
  let current = obj;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Stringify a resolved value for template substitution.
 *
 * @param value - The value to stringify
 * @returns String representation suitable for prompt injection
 */
function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * Resolve all `{{...}}` template expressions in a string.
 *
 * Supported patterns:
 * - `{{trigger.payload}}` - full trigger payload
 * - `{{trigger.payload.field}}` - dot-path into trigger payload
 * - `{{steps.<slug>.result}}` - full result of a completed step
 * - `{{steps.<slug>.result.field}}` - dot-path into step result
 * - `{{steps.<slug>.config}}` - full config of any step in the workflow
 * - `{{steps.<slug>.config.field}}` - dot-path into step config
 * - `{{env.<VAR>}}` - environment variable
 * - `{{secret.<KEY>}}` - encrypted secret (decrypted at access, ACL-checked)
 *
 * @param template - The template string with `{{...}}` expressions
 * @param ctx - The resolution context (trigger payload + step results + step configs)
 * @returns The resolved string, with unresolvable expressions left as-is
 */
export async function resolveTemplates(
  template: string,
  ctx: TemplateContext,
): Promise<{ resolved: string; warnings: string[] }> {
  const warnings: string[] = [];
  const pattern = /\{\{([^}]+)\}\}/g;
  let resolved = "";
  let lastIndex = 0;

  for (let match = pattern.exec(template); match !== null; match = pattern.exec(template)) {
    resolved += template.slice(lastIndex, match.index);
    lastIndex = match.index + match[0].length;

    const expr: string = match[1]!;
    const trimmed = expr.trim();
    const parts = trimmed.split(".");

    // {{env.<VAR>}} - restricted to allowlist to prevent template injection
    if (parts[0] === "env" && parts.length >= 2) {
      const varName = parts.slice(1).join(".");
      if (!getEnvAllowlist().has(varName)) {
        warnings.push(`Access denied for env var "${varName}" - not in workflow allowlist`);
        resolved += `{{${trimmed}}}`;
      } else {
        resolved += process.env[varName] ?? "";
      }
      continue;
    }

    // {{secret.<KEY>}} - decrypt via secret store with workflow identity
    if (parts[0] === "secret" && parts.length === 2) {
      const secretName = parts[1]!;
      if (!ctx.secretStore) {
        warnings.push(`Secret store not available for template: ${trimmed}`);
        resolved += `{{${trimmed}}}`;
        continue;
      }
      if (!ctx.workflowName) {
        warnings.push(`Workflow name not set for secret resolution: ${trimmed}`);
        resolved += `{{${trimmed}}}`;
        continue;
      }
      const result = await ctx.secretStore.resolve(secretName, `workflow:${ctx.workflowName}`);
      if (!result.granted) {
        warnings.push(`Access denied for secret "${secretName}": ${result.reason ?? "no reason"}`);
        resolved += `{{${trimmed}}}`;
      } else if (result.value === null) {
        warnings.push(`Secret "${secretName}" not found`);
        resolved += `{{${trimmed}}}`;
      } else {
        resolved += result.value;
      }
      continue;
    }

    // {{trigger.payload}} or {{trigger.payload.field.subfield}}
    if (parts[0] === "trigger" && parts[1] === "payload") {
      if (parts.length === 2) {
        resolved += stringify(ctx.triggerPayload);
      } else {
        const value = traversePath(ctx.triggerPayload, parts.slice(2));
        if (typeof value === "undefined") {
          warnings.push(`Unresolvable template path: ${trimmed}`);
          resolved += `{{${trimmed}}}`;
        } else {
          resolved += stringify(value);
        }
      }
      continue;
    }

    // {{steps.<slug>.result}} or {{steps.<slug>.result.field}}
    // {{steps.<slug>.config}} or {{steps.<slug>.config.field}}
    if (parts[0] === "steps" && parts.length >= 3) {
      const slug = parts[1];

      // {{steps.<slug>.config}} or {{steps.<slug>.config.<path>}}
      if (parts[2] === "config") {
        if (!ctx.stepConfigs || !(slug! in ctx.stepConfigs)) {
          warnings.push(`Unknown step slug in config template: ${slug}`);
          resolved += `{{${trimmed}}}`;
          continue;
        }
        const stepConfig = ctx.stepConfigs[slug!];
        if (parts.length === 3) {
          resolved += stringify(stepConfig);
        } else {
          const value = traversePath(stepConfig, parts.slice(3));
          if (value === undefined) {
            warnings.push(`Unresolvable template path: ${trimmed}`);
            resolved += `{{${trimmed}}}`;
          } else {
            resolved += stringify(value);
          }
        }
        continue;
      }

      // {{steps.<slug>.result}} or {{steps.<slug>.result.<path>}}
      if (!slug || !(slug in ctx.stepResults)) {
        warnings.push(`Unknown step slug in template: ${slug}`);
        resolved += `{{${trimmed}}}`;
        continue;
      }
      const stepResult = ctx.stepResults[slug];
      if (parts[2] === "result") {
        if (parts.length === 3) {
          resolved += stringify(stepResult);
        } else {
          const value = traversePath(stepResult, parts.slice(3));
          if (value === undefined) {
            warnings.push(`Unresolvable template path: ${trimmed}`);
            resolved += `{{${trimmed}}}`;
          } else {
            resolved += stringify(value);
          }
        }
        continue;
      }
    }

    warnings.push(`Unrecognized template expression: ${trimmed}`);
    resolved += `{{${trimmed}}}`;
  }

  resolved += template.slice(lastIndex);
  return { resolved, warnings };
}
