/**
 * Serialization of registered workflow trigger types into the plain, read-only
 * {@link TriggerTypeInfo} shape surfaced to the frontend (via `GET /api/extensions`)
 * and to extensions in-process (via `ctx.triggerTypes.list()`), so both paths
 * ship the same data.
 *
 * @module
 */

import type { TriggerTypeInfo } from "@shared/extensions";
import type { RegisteredTriggerType } from "../internalTypes";

/**
 * Serialize one registered trigger type: the live TypeBox payload schema is
 * deep-cloned to plain JSON Schema and the `refs` function is reduced to a flag.
 *
 * @param tt - The registered trigger type
 * @returns A plain, serializable {@link TriggerTypeInfo}
 */
export function serializeTriggerType(tt: RegisteredTriggerType): TriggerTypeInfo {
  const { label, description, docs, icon, outputSchema, refs } = tt.definition;
  return {
    type: tt.type,
    label,
    description,
    docs,
    icon,
    extensionName: tt.extensionName,
    hasRefs: typeof refs === "function",
    outputSchema: outputSchema ? (JSON.parse(JSON.stringify(outputSchema)) as Record<string, unknown>) : undefined,
  };
}

/**
 * Serialize a list of registered trigger types.
 *
 * @param triggerTypes - The registered trigger types
 * @returns Plain {@link TriggerTypeInfo} objects, in input order
 */
export function serializeTriggerTypes(triggerTypes: readonly RegisteredTriggerType[]): TriggerTypeInfo[] {
  return triggerTypes.map(serializeTriggerType);
}
