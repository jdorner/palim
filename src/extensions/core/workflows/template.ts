/**
 * Template resolution engine for workflow step fields.
 *
 * Resolves `{{trigger.payload}}`, `{{steps.<slug>.result}}`,
 * `{{env.<VAR>}}`, `{{secret.<KEY>}}`, and `{{var.<KEY>}}` expressions with
 * dot-path traversal. The `{{var.<KEY>}}` namespace substitutes a plaintext
 * global variable value with no decryption or ACL check.
 *
 * Environment variable access is restricted to an explicit allowlist to prevent
 * template injection attacks where attacker-controlled data (webhook payloads,
 * LLM outputs) can exfiltrate sensitive env vars through chained step results.
 */

import { DEFAULT_ENV_ALLOWLIST } from "@shared/workflows";
import type { TemplateVariableResolver } from "@src/variables";
import { evaluateExpression, isForbiddenKey, referencesForbiddenKey } from "./templateEval";

/**
 * Minimal interface for secret resolution within templates.
 */
export interface TemplateSecretResolver {
  resolve(name: string, consumer: string): Promise<{ value: string | null; granted: boolean; reason?: string }>;
}

/**
 * The env allowlist prevents template injection attacks: if attacker-controlled
 * data (e.g. a webhook payload) is echoed by the LLM into a step result, and
 * a subsequent step uses `{{steps.<slug>.result}}`, the template engine would
 * resolve any `{{env.*}}` expressions found in that result. Without an
 * allowlist, this enables exfiltration of sensitive env vars like API keys.
 *
 * The default names come from the shared `DEFAULT_ENV_ALLOWLIST` so that this
 * resolver, the backend DAG validator, and the frontend template scope agree.
 * To add extra vars, set the `WORKFLOW_ENV_ALLOWLIST` environment variable to a
 * comma-separated list of additional var names.
 */

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
  /** Variable resolver (optional - {{var.KEY}} left literal if absent). */
  variableStore?: TemplateVariableResolver;
  /** Iteration context (when inside an iterator body). */
  iterationContext?: {
    /** The current array element. */
    item: unknown;
    /** Zero-based iteration index. */
    itemIndex: number;
    /** The variable name for the current element (e.g. "item"). */
    as: string;
  };
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
    // Refuse prototype-chain / constructor escape keys, matching the evaluator's
    // sandbox. An access to such a key resolves to undefined (which surfaces as
    // the standard "unresolvable path" warning + literal fallback).
    if (isForbiddenKey(segment)) return undefined;
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
 * - `{{var.<KEY>}}` - plaintext global variable (no ACL, no decryption)
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

    // Sandbox guard (applies to ALL expressions, path and evaluated alike):
    // refuse any reference to a prototype-chain / constructor escape key. Such
    // an expression is left literal with a warning and never resolved.
    if (referencesForbiddenKey(trimmed)) {
      warnings.push(`Forbidden key reference in template expression: ${trimmed}`);
      resolved += `{{${trimmed}}}`;
      continue;
    }

    // {{itemIndex}} - zero-based iteration index (only inside iterator body)
    if (trimmed === "itemIndex" && ctx.iterationContext) {
      resolved += String(ctx.iterationContext.itemIndex);
      continue;
    }

    // {{<as>}} or {{<as>.<path>}} - current iteration item (only inside iterator body)
    if (ctx.iterationContext && parts[0] === ctx.iterationContext.as) {
      if (parts.length === 1) {
        resolved += stringify(ctx.iterationContext.item);
      } else {
        const value = traversePath(ctx.iterationContext.item, parts.slice(1));
        resolved += stringify(value);
      }
      continue;
    }

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

    // {{var.<KEY>}} - plaintext global variable (no decryption, no ACL)
    if (parts[0] === "var" && parts.length === 2) {
      const key = parts[1]!;
      if (!ctx.variableStore) {
        warnings.push(`Variable store not available for template: ${trimmed}`);
        resolved += `{{${trimmed}}}`;
        continue;
      }
      const value = ctx.variableStore.resolve(key);
      if (value === null) {
        warnings.push(`Variable "${key}" not found`);
        resolved += `{{${trimmed}}}`;
        continue;
      }
      resolved += value;
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

    // Fallback for expressions that are not plain namespace references.
    //
    // Only expressions that use function-call / operator syntax are routed to
    // the safe evaluator. A plain dot-path that reached this point (e.g. an
    // unknown namespace like `unknown.thing`, or a malformed `var.A.B`) is NOT
    // evaluated: it retains the historical "unrecognized -> left literal +
    // warning" behavior, so existing workflows do not silently change meaning.
    //
    // The evaluator runs against a NON-SENSITIVE scope only. Guarded namespaces
    // (secret, env) are intentionally NOT included: they are resolved above by
    // the dedicated branches and must never be reachable from arbitrary
    // expression logic. The scope exposes the same non-sensitive namespaces the
    // path branches use (trigger, steps, var) plus the iterator alias and
    // itemIndex when inside an iterator body.
    if (isExpressionSyntax(trimmed)) {
      const evalScope = buildExpressionScopeNamespaces(ctx);
      const evalResult = evaluateExpression(trimmed, evalScope);
      if (evalResult.ok) {
        resolved += stringify(evalResult.value);
      } else {
        warnings.push(evalResult.warning ?? `Unrecognized template expression: ${trimmed}`);
        resolved += `{{${trimmed}}}`;
      }
      continue;
    }

    warnings.push(`Unrecognized template expression: ${trimmed}`);
    resolved += `{{${trimmed}}}`;
  }

  resolved += template.slice(lastIndex);
  return { resolved, warnings };
}

/**
 * Determines whether a trimmed expression uses function-call syntax (and
 * therefore requires the safe evaluator). A dot-path - even a malformed one
 * like `var.A.` - is NOT routed to the evaluator: it retains the historical
 * namespace-branch / unrecognized-expression behavior, so existing workflows
 * keep their exact warning semantics.
 *
 * @param trimmed - The trimmed expression text (without braces)
 * @returns True when the expression uses function-call syntax
 */
function isExpressionSyntax(trimmed: string): boolean {
  return trimmed.includes("(");
}

/**
 * Builds the non-sensitive namespace values exposed to the expression
 * evaluator. Includes `trigger`, `steps` (result + config), `var`, and - when
 * inside an iterator body - the iterator alias and `itemIndex`.
 *
 * Deliberately EXCLUDES `secret` and `env`: those are access-controlled and are
 * resolved by dedicated branches before evaluation, never exposed to arbitrary
 * expression logic.
 *
 * @param ctx - The template resolution context
 * @returns A record of namespace name to value for the evaluation scope
 */
function buildExpressionScopeNamespaces(ctx: TemplateContext): Record<string, unknown> {
  const ns: Record<string, unknown> = {};

  // trigger.payload -> expose as `trigger: { payload }`
  ns.trigger = { payload: ctx.triggerPayload };

  // steps.<slug>.result / .config -> expose as `steps: { <slug>: { result, config } }`
  const steps: Record<string, { result?: unknown; config?: unknown }> = {};
  for (const [slug, result] of Object.entries(ctx.stepResults)) {
    steps[slug] = { result };
  }
  if (ctx.stepConfigs) {
    for (const [slug, config] of Object.entries(ctx.stepConfigs)) {
      steps[slug] = { ...(steps[slug] ?? {}), config };
    }
  }
  ns.steps = steps;

  // var.<KEY> - plaintext global variables (no ACL). The variable keys are not
  // enumerable up front, so `var` is exposed as a lazy lookup backed by the
  // resolver. The proxy target is null-prototype so that stray prototype-chain
  // keys (constructor, etc.) are not reachable even before the lexical
  // forbidden-key check.
  if (ctx.variableStore) {
    const store = ctx.variableStore;
    ns.var = new Proxy(Object.create(null), {
      get(_t, key: string) {
        return store.has(key) ? store.resolve(key) : undefined;
      },
      has(_t, key: string) {
        return store.has(key);
      },
    });
  }

  // Iterator body: alias + itemIndex
  if (ctx.iterationContext) {
    ns[ctx.iterationContext.as] = ctx.iterationContext.item;
    ns.itemIndex = ctx.iterationContext.itemIndex;
  }

  return ns;
}
