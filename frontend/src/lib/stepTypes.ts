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
 * Handles built-in types (trigger, agent, webhook) and custom extension types.
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
          return "🔗 Webhook Trigger";
        case "schedule":
          return "⏰ Schedule Trigger";
        case "manual":
          return "▶️ Manual Trigger";
        case "filewatcher":
          return "👁️ File Watcher Trigger";
        default:
          return "⚡ Trigger";
      }
    case "agent":
      return "🤖 Agent";
    case "webhook":
      return "📡 Webhook";
    default:
      return getCustomStepLabel(type) ?? `\u2699\uFE0F ${type.charAt(0).toUpperCase()}${type.slice(1)}`;
  }
}
