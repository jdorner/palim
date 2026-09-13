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
import { enrichSchema } from "@src/web/dynamicProviders";
import type { RegisteredStepType } from "../internalTypes";

/**
 * Serialize a single registered step type into its read-only metadata form.
 *
 * The handler's `schema` (config input) is run through {@link enrichSchema} so
 * dynamic-item/default providers are resolved, matching the workflow editor's
 * expectations. The handler's `outputSchema` (produced-data shape) is serialized
 * verbatim to JSON Schema WITHOUT enrichment, since enrichment is a config-input
 * concern only. Both schemas are deep-cloned via `JSON.parse(JSON.stringify(...))`
 * so callers receive plain, mutation-safe data rather than the live TypeBox object.
 *
 * @param st - The registered step type (type identifier, handler, owning extension)
 * @returns A plain, serializable {@link StepTypeInfo}
 */
export function serializeStepType(st: RegisteredStepType): StepTypeInfo {
  return {
    type: st.type,
    label: st.handler.label,
    icon: st.handler.icon,
    extensionName: st.extensionName,
    terminal: st.handler.terminal ?? false,
    category: st.handler.category,
    configSchema: st.handler.schema ? enrichSchema(JSON.parse(JSON.stringify(st.handler.schema))) : undefined,
    outputSchema: st.handler.outputSchema
      ? (JSON.parse(JSON.stringify(st.handler.outputSchema)) as Record<string, unknown>)
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
