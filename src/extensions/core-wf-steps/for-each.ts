/**
 * For-each step type handler.
 *
 * Iterates over an array resolved from a template expression and executes
 * a sub-DAG of steps for each element. This enables workflows to process
 * dynamic-length collections (e.g. webhook payloads with multiple items)
 * without LLM involvement for the iteration logic itself.
 *
 * Each iteration receives a scoped template context where `{{item}}` (or
 * a custom variable name via `as`) resolves to the current array element
 * and `{{itemIndex}}` resolves to the zero-based iteration index.
 *
 * Sub-steps within each iteration can reference each other's results via
 * `{{steps.<slug>.result}}` as usual — the scope is per-iteration.
 */

import type { StepExecutionContext, StepTypeHandler } from "@ext/types";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { formatValidationErrors } from "@src/utils/validation";

// ---------------------------------------------------------------------------
// Configuration Schema
// ---------------------------------------------------------------------------

/** TypeBox schema for the for-each step configuration. */
const ForEachStepConfigSchema = Type.Object(
  {
    items: Type.String({
      title: "Items",
      description:
        "Template expression that resolves to a JSON array (e.g. '{{trigger.payload}}'). " +
        "The resolved string is parsed as JSON.",
      minLength: 1,
    }),
    as: Type.Optional(
      Type.String({
        title: "Item Variable",
        description: "Variable name for the current element in templates. Default: 'item'.",
        minLength: 1,
        pattern: "^[a-zA-Z][a-zA-Z0-9_]*$",
      }),
    ),
    concurrency: Type.Optional(
      Type.Integer({
        title: "Concurrency",
        description: "Maximum parallel iterations. Default: 1 (sequential).",
        minimum: 1,
        maximum: 20,
        default: 1,
      }),
    ),
    failStrategy: Type.Optional(
      Type.Union([Type.Literal("fail-fast"), Type.Literal("continue")], {
        title: "Failure Strategy",
        description:
          "'fail-fast' aborts on first error. 'continue' processes all items and collects partial results. Default: 'fail-fast'.",
        default: "fail-fast",
      }),
    ),
    steps: Type.Record(Type.String(), Type.Record(Type.String(), Type.Unknown()), {
      title: "Sub-Steps",
      description: "Step definitions to execute per iteration (same format as top-level workflow steps).",
    }),
    edges: Type.Optional(
      Type.Array(
        Type.Object({
          from: Type.String({ minLength: 1 }),
          to: Type.String({ minLength: 1 }),
        }),
        {
          title: "Sub-Edges",
          description: "Edges between sub-steps (defines execution order within each iteration).",
        },
      ),
    ),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed configuration after validation. */
interface ForEachConfig {
  items: string;
  as: string;
  concurrency: number;
  failStrategy: "fail-fast" | "continue";
  steps: Record<string, Record<string, unknown>>;
  edges: Array<{ from: string; to: string }>;
}

/** Result of a single iteration. */
interface IterationResult {
  index: number;
  status: "completed" | "failed";
  stepResults: Record<string, unknown>;
  error?: string;
}

/** Dependencies injected into the for-each handler at creation time. */
export interface ForEachHandlerDeps {
  /**
   * Resolves a step type name to its registered handler.
   * Returns undefined if the type is not registered.
   */
  getStepHandler: (type: string) => StepTypeHandler | undefined;

  /**
   * Runs an agent step inline (without a separate queue job).
   * Used when a sub-step has type "agent".
   *
   * @param prompt - The resolved prompt string
   * @param opts - Agent configuration (tools, skills)
   * @param jobLog - Function to log messages to the parent job
   * @returns The agent's text response
   */
  runAgentInline?: (
    prompt: string,
    opts: { tools?: string[]; skills?: string[] },
    jobLog: (msg: string) => Promise<void>,
  ) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Topological Sort for Sub-DAG
// ---------------------------------------------------------------------------

/**
 * Computes the execution order of sub-steps using topological sort.
 * Steps with no dependencies execute first (roots), then their dependents.
 *
 * @param steps - The step definitions (keyed by slug)
 * @param edges - The edges defining execution order
 * @returns Ordered list of step slugs
 * @throws If there is a cycle in the sub-DAG
 */
function topoSort(steps: Record<string, unknown>, edges: Array<{ from: string; to: string }>): string[] {
  const slugs = Object.keys(steps);
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const slug of slugs) {
    inDegree.set(slug, 0);
    adjacency.set(slug, []);
  }

  for (const edge of edges) {
    if (!inDegree.has(edge.from) || !inDegree.has(edge.to)) continue;
    adjacency.get(edge.from)!.push(edge.to);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [slug, deg] of inDegree) {
    if (deg === 0) queue.push(slug);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);
    for (const neighbor of adjacency.get(current) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (sorted.length !== slugs.length) {
    throw new Error("Cycle detected in for-each sub-step edges");
  }

  return sorted;
}

// ---------------------------------------------------------------------------
// Handler Factory
// ---------------------------------------------------------------------------

/**
 * Creates the for-each step type handler.
 *
 * @param deps - Dependencies providing step handler resolution and optional agent runner
 * @returns A {@link StepTypeHandler} for the `for-each` step type
 */
export function createForEachHandler(deps: ForEachHandlerDeps): StepTypeHandler {
  return {
    schema: ForEachStepConfigSchema,
    outputSchema: Type.Object({
      results: Type.Array(Type.Unknown(), {
        description: "Array of per-iteration results (one entry per item, containing sub-step results).",
      }),
      totalItems: Type.Number({ description: "Total number of items processed." }),
      succeeded: Type.Number({ description: "Number of iterations that completed successfully." }),
      failed: Type.Number({ description: "Number of iterations that failed." }),
    }),
    label: "For Each",
    icon: "RepeatIcon",
    category: "control-flow",

    async execute(stepDef: Record<string, unknown>, ctx: StepExecutionContext): Promise<unknown> {
      const { slug: _slug, type: _type, outputSchema: _os, ...configFields } = stepDef;

      if (!Value.Check(ForEachStepConfigSchema, configFields)) {
        const errorMsg = formatValidationErrors(ForEachStepConfigSchema, configFields);
        throw new Error(`Invalid for-each step configuration: ${errorMsg}`);
      }

      const config: ForEachConfig = {
        items: (configFields as { items: string }).items,
        as: (configFields as { as?: string }).as ?? "item",
        concurrency: (configFields as { concurrency?: number }).concurrency ?? 1,
        failStrategy: (configFields as { failStrategy?: "fail-fast" | "continue" }).failStrategy ?? "fail-fast",
        steps: (configFields as { steps: Record<string, Record<string, unknown>> }).steps,
        edges: (configFields as { edges?: Array<{ from: string; to: string }> }).edges ?? [],
      };

      // Resolve the items expression to get the array
      const { resolved: itemsJson, warnings: itemsWarnings } = await ctx.resolveTemplate(config.items);
      for (const w of itemsWarnings) {
        await ctx.jobLog(`Warning (items): ${w}`);
      }

      // Parse the resolved string as JSON array
      let items: unknown[];
      try {
        const parsed = JSON.parse(itemsJson);
        if (!Array.isArray(parsed)) {
          throw new Error(`Expected an array, got ${typeof parsed}`);
        }
        items = parsed;
      } catch (err) {
        throw new Error(
          `for-each: failed to parse items as JSON array: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (items.length === 0) {
        await ctx.jobLog("for-each: items array is empty, nothing to iterate");
        return { results: [], totalItems: 0, succeeded: 0, failed: 0 };
      }

      await ctx.jobLog(`for-each: processing ${items.length} item(s) with concurrency ${config.concurrency}`);

      // Compute execution order for sub-steps
      const executionOrder = topoSort(config.steps, config.edges);

      // Execute iterations
      const results: IterationResult[] = [];

      if (config.concurrency === 1) {
        // Sequential execution
        for (let i = 0; i < items.length; i++) {
          const result = await executeIteration(i, items[i], config, executionOrder, ctx, deps);
          results.push(result);

          if (result.status === "failed" && config.failStrategy === "fail-fast") {
            throw new Error(`for-each: iteration ${i} failed: ${result.error}`);
          }
        }
      } else {
        // Parallel execution with concurrency limit
        const pending: Array<Promise<IterationResult>> = [];
        let aborted = false;

        for (let i = 0; i < items.length; i++) {
          if (aborted) break;

          const promise = executeIteration(i, items[i], config, executionOrder, ctx, deps);
          pending.push(promise);

          // When we hit the concurrency limit, wait for one to finish
          if (pending.length >= config.concurrency) {
            const settled = await Promise.race(pending.map((p, idx) => p.then((r) => ({ result: r, idx }))));
            results.push(settled.result);
            pending.splice(settled.idx, 1);

            if (settled.result.status === "failed" && config.failStrategy === "fail-fast") {
              aborted = true;
            }
          }
        }

        // Wait for remaining in-flight iterations
        const remaining = await Promise.allSettled(pending);
        for (const r of remaining) {
          if (r.status === "fulfilled") {
            results.push(r.value);
          } else {
            results.push({ index: -1, status: "failed", stepResults: {}, error: String(r.reason) });
          }
        }

        // Check if we should fail after collecting all results
        if (aborted) {
          const failedResult = results.find((r) => r.status === "failed");
          throw new Error(`for-each: iteration ${failedResult?.index} failed: ${failedResult?.error}`);
        }
      }

      // Sort results by index for consistent output
      results.sort((a, b) => a.index - b.index);

      const succeeded = results.filter((r) => r.status === "completed").length;
      const failed = results.filter((r) => r.status === "failed").length;

      await ctx.jobLog(`for-each: completed. ${succeeded} succeeded, ${failed} failed out of ${items.length}`);

      return {
        results: results.map((r) => r.stepResults),
        totalItems: items.length,
        succeeded,
        failed,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Iteration Execution
// ---------------------------------------------------------------------------

/**
 * Executes a single iteration of the for-each loop.
 *
 * Creates a scoped template context for the current item and runs all sub-steps
 * in topological order.
 *
 * @param index - Zero-based iteration index
 * @param item - The current array element
 * @param config - The for-each configuration
 * @param executionOrder - Topologically sorted sub-step slugs
 * @param ctx - The parent step execution context
 * @param deps - Handler dependencies
 * @returns The iteration result with sub-step outputs
 */
async function executeIteration(
  index: number,
  item: unknown,
  config: ForEachConfig,
  executionOrder: string[],
  ctx: StepExecutionContext,
  deps: ForEachHandlerDeps,
): Promise<IterationResult> {
  const iterStepResults: Record<string, unknown> = {};

  await ctx.jobLog(`[${index + 1}/${config.as}] Starting iteration`);

  try {
    for (const slug of executionOrder) {
      const subStepDef = config.steps[slug];
      if (!subStepDef) continue;

      const stepType = subStepDef.type as string;
      if (!stepType) {
        throw new Error(`Sub-step "${slug}" is missing a 'type' field`);
      }

      // Build a scoped resolveTemplate that adds item/itemIndex to the context
      const scopedResolveTemplate = async (template: string): Promise<{ resolved: string; warnings: string[] }> => {
        // First, substitute item-scoped expressions before delegating to the parent resolver
        const itemResolved = resolveItemExpressions(template, item, index, config.as, iterStepResults);
        return ctx.resolveTemplate(itemResolved);
      };

      // Build sub-step execution context
      const subCtx: StepExecutionContext = {
        resolveTemplate: scopedResolveTemplate,
        log: ctx.log,
        workDir: ctx.workDir,
        jobLog: async (msg: string) => ctx.jobLog(`[${index + 1}/${slug}] ${msg}`),
        workflowRunId: ctx.workflowRunId,
      };

      let result: unknown;

      if (stepType === "agent") {
        // Agent sub-step
        if (!deps.runAgentInline) {
          throw new Error(`for-each: agent sub-steps require runAgentInline dependency (step "${slug}")`);
        }

        const agentDef = subStepDef as { prompt?: string | string[]; tools?: string[]; skills?: string[] };
        const rawPrompt = Array.isArray(agentDef.prompt) ? agentDef.prompt.join("\n") : (agentDef.prompt ?? "");
        const { resolved: resolvedPrompt } = await scopedResolveTemplate(rawPrompt);

        result = await deps.runAgentInline(
          resolvedPrompt,
          { tools: agentDef.tools, skills: agentDef.skills },
          async (msg) => ctx.jobLog(`[${index + 1}/${slug}] ${msg}`),
        );
      } else {
        // Custom step type handler
        const handler = deps.getStepHandler(stepType);
        if (!handler) {
          throw new Error(`for-each: no handler registered for sub-step type "${stepType}" (step "${slug}")`);
        }

        // Resolve templates in string fields of the sub-step definition
        const resolvedDef: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(subStepDef)) {
          if (typeof val === "string" && val.includes("{{")) {
            const { resolved } = await scopedResolveTemplate(val);
            resolvedDef[key] = resolved;
          } else {
            resolvedDef[key] = val;
          }
        }

        result = await handler.execute(resolvedDef, subCtx);
      }

      iterStepResults[slug] = result;
    }

    return { index, status: "completed", stepResults: iterStepResults };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await ctx.jobLog(`[${index + 1}/${config.as}] Iteration failed: ${errorMsg}`);
    return { index, status: "failed", stepResults: iterStepResults, error: errorMsg };
  }
}

// ---------------------------------------------------------------------------
// Item Expression Resolution
// ---------------------------------------------------------------------------

/**
 * Resolves item-scoped template expressions before the parent resolver handles
 * the rest. Substitutes:
 * - `{{<as>}}` or `{{<as>.<path>}}` with the current item value
 * - `{{itemIndex}}` with the zero-based index
 * - `{{steps.<slug>.result}}` with sub-step results from the current iteration
 *
 * @param template - The template string
 * @param item - The current array element
 * @param index - The current iteration index
 * @param asName - The variable name for the current element
 * @param iterStepResults - Results from previously executed sub-steps in this iteration
 * @returns The template with item-scoped expressions resolved
 */
function resolveItemExpressions(
  template: string,
  item: unknown,
  index: number,
  asName: string,
  iterStepResults: Record<string, unknown>,
): string {
  const pattern = /\{\{([^}]+)\}\}/g;
  return template.replace(pattern, (match, expr: string) => {
    const trimmed = expr.trim();
    const parts = trimmed.split(".");

    // {{itemIndex}}
    if (trimmed === "itemIndex") {
      return String(index);
    }

    // {{<as>}} or {{<as>.<path>}}
    if (parts[0] === asName) {
      if (parts.length === 1) {
        return stringify(item);
      }
      const value = traversePath(item, parts.slice(1));
      return stringify(value);
    }

    // {{steps.<slug>.result}} or {{steps.<slug>.result.<path>}} - scoped to iteration
    if (parts[0] === "steps" && parts.length >= 3 && parts[2] === "result") {
      const slug = parts[1]!;
      if (slug in iterStepResults) {
        if (parts.length === 3) {
          return stringify(iterStepResults[slug]);
        }
        const value = traversePath(iterStepResults[slug], parts.slice(3));
        return stringify(value);
      }
    }

    // Not an item-scoped expression — leave it for the parent resolver
    return match;
  });
}

// ---------------------------------------------------------------------------
// Utility Functions (duplicated from template.ts to avoid cross-extension import)
// ---------------------------------------------------------------------------

/**
 * Traverse an object by dot-separated path segments.
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
 */
function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
