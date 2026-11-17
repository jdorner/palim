/**
 * Advisory warnings about the design of a workflow, as opposed to its
 * correctness: shapes that validate and run, but break on real data.
 *
 * - **Whole list in a prompt:** an agent step whose prompt pastes a list of
 *   objects from an earlier step. It works with three items and overflows the
 *   model's context with fifty.
 * - **Free text read as data:** an agent step without `outputSchema` whose
 *   result another step reads a field of. Without a schema the result is the
 *   model's text, so the field does not exist.
 *
 * @module
 */

import { isObjectSchemaNode, type OutputSchema, unwrapArrayItems, walkSchemaPath } from "@shared/workflows";
import { getTemplateFields, type TemplateWarning, templateReferences } from "./dagTemplateValidation";
import { definitionTopology } from "./definitionTopology";
import type { DagWorkflowDefinition } from "./schemas";

/** A `steps.<slug>.result[.<path>]` reference, split. */
interface ResultRef {
  /** The referenced step. */
  slug: string;
  /** The path below `result` (empty for the bare result). */
  path: string[];
}

/**
 * Splits a path reference when it reads a step result.
 *
 * @param pathRef - A path reference as the template validator extracts it
 * @param slugs - The workflow's step slugs
 * @returns The referenced step and the path below its result, or `null` for any other reference
 */
function parseResultRef(pathRef: string, slugs: ReadonlySet<string>): ResultRef | null {
  if (!pathRef.startsWith("steps.")) return null;
  const rest = pathRef.slice("steps.".length);
  // The slug may contain hyphens but no dots, so it ends at the first dot.
  const dot = rest.indexOf(".");
  if (dot === -1) return null;
  const slug = rest.slice(0, dot);
  const parts = rest.slice(dot + 1).split(".");
  if (!slugs.has(slug) || parts[0] !== "result") return null;
  return { slug, path: parts.slice(1) };
}

/**
 * Warns about agent prompts that paste a whole list of objects.
 *
 * Fires when an agent step's prompt contains a bare `{{steps.<slug>.result...}}`
 * placeholder (not wrapped in a function or expression) whose schema is an
 * array of objects. A reference to an `aggregator` is exempt: summarising the
 * collected results after a loop is the intended use.
 *
 * @param definition - The workflow definition
 * @param resolveStepOutputSchema - The resolved output schema of a step, or `null` when unknown
 * @returns One warning per pasted list, on the agent step's `prompt`
 */
function getWholeListWarnings(
  definition: DagWorkflowDefinition,
  resolveStepOutputSchema: (slug: string) => OutputSchema | null,
): TemplateWarning[] {
  const slugs = new Set(Object.keys(definition.steps));
  const warnings: TemplateWarning[] = [];
  for (const [slug, step] of Object.entries(definition.steps)) {
    if (step.type !== "agent") continue;
    const reported = new Set<string>();
    for (const [field, text] of getTemplateFields(step)) {
      for (const ref of templateReferences(text, slugs)) {
        if (!ref.plain || reported.has(ref.expr)) continue;
        const result = parseResultRef(ref.expr, slugs);
        if (!result || result.slug === slug || definition.steps[result.slug]?.type === "aggregator") continue;
        const walked = walkSchemaPath(resolveStepOutputSchema(result.slug), result.path);
        const item = walked.resolved ? unwrapArrayItems(walked.node) : null;
        if (!item || !isObjectSchemaNode(item)) continue;
        reported.add(ref.expr);
        warnings.push({
          stepSlug: slug,
          field,
          message: `The prompt gets the whole list {{${ref.expr}}}. With many or large items this overflows the model's context. To handle one item per pass, put this step inside an iterator over that list. Keep it as is only if the step must see all items at once (for example one summary of all).`,
        });
      }
    }
  }
  return warnings;
}

/**
 * Warns about agent steps without `outputSchema` whose result another step
 * reads a field of: `{{steps.<agent>.result.<field>}}`, or through the
 * aggregator that collects the agent step
 * (`{{steps.<aggregator>.result.results.<n>.<agent>.<field>}}`).
 *
 * A bare `{{steps.<agent>.result}}` stays silent: handing free text to a
 * notification or to another prompt is a correct design. So does `.length`,
 * which a text has.
 *
 * @param definition - The workflow definition
 * @returns One warning per agent step, on its `outputSchema`, naming the first step that reads it
 */
function getFreeTextAsDataWarnings(definition: DagWorkflowDefinition): TemplateWarning[] {
  const slugs = new Set(Object.keys(definition.steps));
  const topology = definitionTopology(definition);

  /** Agent steps without a schema, by the aggregator that collects them. */
  const collectedBy = new Map<string, Set<string>>();
  const schemaless = new Set<string>();
  for (const [slug, step] of Object.entries(definition.steps)) {
    if (step.type !== "agent" || (step as { outputSchema?: unknown }).outputSchema !== undefined) continue;
    schemaless.add(slug);
    const iterator = topology.enclosingIterator(slug);
    const body = iterator ? topology.iteratorBody(iterator) : null;
    if (body?.terminals.includes(slug)) {
      collectedBy.set(body.aggregator, (collectedBy.get(body.aggregator) ?? new Set()).add(slug));
    }
  }
  if (schemaless.size === 0) return [];

  /** The schema-less agent step a reference reads a field of, if any. */
  const readsFieldOf = (ref: ResultRef): string | null => {
    if (schemaless.has(ref.slug)) {
      return ref.path.length > 0 && ref.path[0] !== "length" ? ref.slug : null;
    }
    const collected = collectedBy.get(ref.slug);
    if (!collected || ref.path[0] !== "results") return null;
    // results[.<index>].<agent>.<field>
    const below = ref.path.slice(1).filter((part, i) => !(i === 0 && /^\d+$/.test(part)));
    const [agent, field] = below;
    return agent !== undefined && collected.has(agent) && field !== undefined && field !== "length" ? agent : null;
  };

  const warned = new Map<string, TemplateWarning>();
  for (const [reader, step] of Object.entries(definition.steps)) {
    for (const [, text] of getTemplateFields(step)) {
      for (const ref of templateReferences(text, slugs)) {
        for (const pathRef of ref.pathRefs) {
          const result = parseResultRef(pathRef, slugs);
          const agent = result ? readsFieldOf(result) : null;
          if (!agent || agent === reader || warned.has(agent)) continue;
          warned.set(agent, {
            stepSlug: agent,
            field: "outputSchema",
            message: `Step "${agent}" returns free text, but "${reader}" reads its result as data. Add an outputSchema to "${agent}" so the result has fixed fields.`,
          });
        }
      }
    }
  }
  return [...warned.values()];
}

/**
 * Collects the design warnings of a workflow: whole lists pasted into agent
 * prompts, and agent results read as data without an `outputSchema`.
 *
 * Pure: the output schemas are passed in, resolved once by the analyzer.
 *
 * @param definition - The workflow definition
 * @param resolveStepOutputSchema - The resolved output schema of a step, or `null` when unknown
 * @returns The warnings (empty when the design has none of these shapes)
 */
export function getDesignWarnings(
  definition: DagWorkflowDefinition,
  resolveStepOutputSchema: (slug: string) => OutputSchema | null,
): TemplateWarning[] {
  return [...getWholeListWarnings(definition, resolveStepOutputSchema), ...getFreeTextAsDataWarnings(definition)];
}
