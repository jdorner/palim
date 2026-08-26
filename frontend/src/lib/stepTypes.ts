/**
 * Shared utilities for workflow step type labels.
 *
 * Used by both WorkflowStepNode (graph rendering) and WorkflowDetailPage
 * (step type dropdown) to provide consistent labeling. Labels are plain text;
 * icons are rendered separately from the shared icon registry (see
 * `nodeVisuals.ts` / `iconRegistry.ts`).
 */

import { get } from "svelte/store";
import { extensions } from "./extensionStore";

/**
 * Looks up a registered custom step type's label from the extension store.
 *
 * @param type - The step type identifier (e.g. "excel")
 * @returns The label, or undefined if not found in any enabled extension
 */
export function getCustomStepLabel(type: string): string | undefined {
  const allExtensions = get(extensions);
  for (const ext of allExtensions) {
    if (!ext.enabled || !ext.ui?.stepTypes) continue;
    const match = ext.ui.stepTypes.find((st) => st.type === type);
    if (match) return match.label;
  }
  return undefined;
}

/**
 * Resolves a custom step type's registered icon id from the extension store.
 *
 * Built-in types (agent, if, case, ...) return undefined because their icons
 * are resolved directly by `visualForStepType` from its built-in map; only
 * custom extension types carry an icon id here.
 *
 * @param type - The step type identifier (e.g. "excel")
 * @returns The icon registry key, or undefined if the type is built-in or has no icon
 */
export function iconIdForType(type: string): string | undefined {
  const allExtensions = get(extensions);
  for (const ext of allExtensions) {
    if (!ext.enabled || !ext.ui?.stepTypes) continue;
    const match = ext.ui.stepTypes.find((st) => st.type === type);
    if (match) return match.icon;
  }
  return undefined;
}

/**
 * Resolves a custom step type's declared palette category from the extension
 * store. This drives the node accent color (control-flow types share the sky
 * "logic" accent with built-in CF nodes; the rest use the amber action accent).
 *
 * Built-in types return undefined because their category comes from the
 * built-in map in `visualForStepType`; only custom extension types carry a
 * category here.
 *
 * @param type - The step type identifier (e.g. "for-each")
 * @returns The category string, or undefined if the type is built-in or declares none
 */
export function categoryForType(type: string): string | undefined {
  const allExtensions = get(extensions);
  for (const ext of allExtensions) {
    if (!ext.enabled || !ext.ui?.stepTypes) continue;
    const match = ext.ui.stepTypes.find((st) => st.type === type);
    if (match) return match.category;
  }
  return undefined;
}

/**
 * Returns a plain-text human-readable label for a workflow step type.
 * Handles the built-in agent/control-flow types, triggers, and custom
 * extension types. Icons are rendered separately via the icon registry.
 *
 * @param type - The step type identifier
 * @param triggerType - Optional trigger subtype (webhook, schedule, manual, filewatcher)
 * @returns Plain-text label string (no icon prefix)
 */
export function labelForStepType(type: string, triggerType?: string): string {
  switch (type) {
    case "trigger":
      switch (triggerType) {
        case "webhook":
          return "Webhook Trigger";
        case "schedule":
          return "Schedule Trigger";
        case "manual":
          return "Manual Trigger";
        case "filewatcher":
          return "File Watcher Trigger";
        default:
          return "Trigger";
      }
    case "agent":
      return "Agent";
    case "if":
      return "If";
    case "case":
      return "Case";
    case "waitFor":
      return "Wait For";
    case "emit":
      return "Emit";
    default:
      return getCustomStepLabel(type) ?? `${type.charAt(0).toUpperCase()}${type.slice(1)}`;
  }
}
