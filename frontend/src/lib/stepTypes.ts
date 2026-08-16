/**
 * Shared utilities for workflow step type labels and icons.
 *
 * Used by both WorkflowStepNode (graph rendering) and WorkflowDetailPage
 * (step type dropdown) to provide consistent labeling.
 */

import { get } from "svelte/store";
import { extensions } from "./extensionStore";

/**
 * Looks up a registered custom step type's label and icon from the extension store.
 *
 * @param type - The step type identifier (e.g. "excel")
 * @returns Formatted label with icon, or undefined if not found in any extension
 */
export function getCustomStepLabel(type: string): string | undefined {
  const allExtensions = get(extensions);
  for (const ext of allExtensions) {
    if (!ext.enabled || !ext.ui?.stepTypes) continue;
    const match = ext.ui.stepTypes.find((st) => st.type === type);
    if (match) return `${match.icon ?? "\u2699\uFE0F"} ${match.label}`;
  }
  return undefined;
}

/**
 * Returns a human-readable label (with icon) for a workflow step type.
 * Handles the built-in agent type and custom extension types (including http-request).
 *
 * @param type - The step type identifier
 * @param triggerType - Optional trigger subtype (webhook, schedule, manual, filewatcher)
 * @returns Formatted label string with emoji prefix
 */
export function labelForStepType(type: string, triggerType?: string): string {
  switch (type) {
    case "trigger":
      switch (triggerType) {
        case "webhook":
          return "\uD83D\uDD17 Webhook Trigger";
        case "schedule":
          return "\u23F0 Schedule Trigger";
        case "manual":
          return "\u25B6\uFE0F Manual Trigger";
        case "filewatcher":
          return "\uD83D\uDC41\uFE0F File Watcher Trigger";
        default:
          return "\u26A1 Trigger";
      }
    case "agent":
      return "\uD83E\uDD16 Agent";
    case "if":
      return "\u2194\uFE0F If";
    case "case":
      return "\uD83D\uDD00 Case";
    case "waitFor":
      return "\u23F8\uFE0F Wait For";
    case "emit":
      return "\uD83D\uDCE1 Emit";
    default:
      return getCustomStepLabel(type) ?? `\u2699\uFE0F ${type.charAt(0).toUpperCase()}${type.slice(1)}`;
  }
}
