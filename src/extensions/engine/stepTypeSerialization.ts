/**
 * Serialization of registered workflow step types into the plain, read-only
 * {@link StepTypeInfo} shape surfaced to the frontend (via `GET /api/extensions`)
 * and to extensions in-process (via `ctx.stepTypes.list()`).
 *
 * Kept in one place so the HTTP path and the in-process path cannot drift:
 * both consume {@link serializeStepType}, which converts a handler's live
 * TypeBox schemas into plain JSON Schema objects and strips the executable
 * `execute` function. Consumers therefore never receive the live handler.
 */

import type { StepTypeInfo } from "@shared/extensions";
import type { TSchema } from "@sinclair/typebox";
import { enrichSchema } from "@src/web/dynamicProviders";
import type { RegisteredStepType } from "../internalTypes";
import type { StepTypeHandler } from "../types";

/**
 * Resolve a handler's `outputSchema` to a concrete TypeBox schema for a given
 * step instance.
 *
 * The `outputSchema` field is either a static TypeBox `TSchema` or a function
 * that derives the schema from the step's own configuration (see
 * {@link StepTypeHandler.outputSchema}). This helper collapses both forms to a
 * single `TSchema | undefined`, so every consumer resolves the schema the same
 * way and the static and dynamic forms cannot diverge.
 *
 * The function form is invoked defensively: because it may run against a
 * partial or invalid config while the workflow is being edited, any thrown
 * error is swallowed and treated as "no schema" (`undefined`).
 *
 * @param outputSchema - The handler's declared `outputSchema` (static, function, or absent)
 * @param stepDef - The serialized step definition passed to the function form.
 *   Pass `{}` when resolving a step TYPE (no instance config exists yet).
 * @returns The resolved TypeBox schema, or `undefined` when none is declared
 *   or the function form declines / throws
 */
export function resolveHandlerOutputSchema(
  outputSchema: StepTypeHandler["outputSchema"],
  stepDef: Record<string, unknown>,
): TSchema | undefined {
  if (typeof outputSchema === "function") {
    try {
      return outputSchema(stepDef);
    } catch {
      return undefined;
    }
  }
  return outputSchema;
}

/**
 * Serialize a single registered step type into its read-only metadata form.
 *
 * The handler's `schema` (config input) is run through {@link enrichSchema} so
 * dynamic-item/default providers are resolved, matching the workflow editor's
 * expectations. The handler's `outputSchema` (produced-data shape) is resolved
 * via {@link resolveHandlerOutputSchema} - collapsing the static and function
 * forms - then serialized verbatim to JSON Schema WITHOUT enrichment, since
 * enrichment is a config-input concern only. Because a step TYPE has no instance
 * config, the function form is resolved with an empty `{}`, yielding its generic
 * base shape. Both schemas are deep-cloned via `JSON.parse(JSON.stringify(...))`
 * so callers receive plain, mutation-safe data rather than the live TypeBox object.
 *
 * @param st - The registered step type (type identifier, handler, owning extension)
 * @returns A plain, serializable {@link StepTypeInfo}
 */
export function serializeStepType(st: RegisteredStepType): StepTypeInfo {
  const resolvedOutputSchema = resolveHandlerOutputSchema(st.handler.outputSchema, {});
  return {
    type: st.type,
    label: st.handler.label,
    icon: st.handler.icon,
    extensionName: st.extensionName,
    terminal: st.handler.terminal ?? false,
    category: st.handler.category,
    configSchema: st.handler.schema ? enrichSchema(JSON.parse(JSON.stringify(st.handler.schema))) : undefined,
    outputSchema: resolvedOutputSchema
      ? (JSON.parse(JSON.stringify(resolvedOutputSchema)) as Record<string, unknown>)
      : undefined,
  };
}

/**
 * Serialize a list of registered step types.
 *
 * @param stepTypes - The registered step types to serialize
 * @returns Plain {@link StepTypeInfo} objects, in input order
 */
export function serializeStepTypes(stepTypes: readonly RegisteredStepType[]): StepTypeInfo[] {
  return stepTypes.map(serializeStepType);
}
