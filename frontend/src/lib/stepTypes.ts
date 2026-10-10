/**
 * Shared utilities for workflow step type labels.
 *
 * Used by both WorkflowStepNode (graph rendering) and WorkflowDetailPage
 * (step type dropdown) to provide consistent labeling. Labels are plain text;
 * icons are rendered separately from the shared icon registry (see
 * `nodeVisuals.ts` / `iconRegistry.ts`).
 */

import { get } from "svelte/store";
import type { StepTypeInfo } from "$shared/extensions";
import { extensions } from "./extensionStore";
import { translateCore as t, translateExtension } from "./i18nCore";

/**
 * Returns a step type with its label translated through the owning extension's
 * catalog (`steps.<type>.label`), falling back to the registered label.
 *
 * @param stepType - The registered step type
 * @returns A copy with the localized label
 */
export function localizeStepType<T extends Pick<StepTypeInfo, "type" | "label" | "extensionName">>(stepType: T): T {
  return {
    ...stepType,
    label: translateExtension(stepType.extensionName, `steps.${stepType.type}.label`, stepType.label),
  };
}

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
    if (match) return translateExtension(ext.name, `steps.${type}.label`, match.label);
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
 * Whether a step type may reference its own result inside an iterator body
 * (declared by the handler's `selfReference` flag, e.g. `set-variables`).
 * Built-in types never do.
 *
 * @param type - The step type identifier
 * @returns True when the registered step type declares `selfReference`
 */
export function allowsSelfReference(type: string): boolean {
  const allExtensions = get(extensions);
  for (const ext of allExtensions) {
    if (!ext.enabled || !ext.ui?.stepTypes) continue;
    const match = ext.ui.stepTypes.find((st) => st.type === type);
    if (match) return match.selfReference === true;
  }
  return false;
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
          return t("stepType.webhookTrigger");
        case "schedule":
          return t("stepType.scheduleTrigger");
        case "manual":
          return t("stepType.manualTrigger");
        case "filewatcher":
          return t("stepType.filewatcherTrigger");
        default:
          return t("stepType.trigger");
      }
    case "agent":
      return t("stepType.agent");
    case "if":
      return t("stepType.if");
    case "case":
      return t("stepType.case");
    case "iterator":
      return t("stepType.iterator");
    case "aggregator":
      return t("stepType.aggregator");
    case "waitFor":
      return t("stepType.waitFor");
    case "emit":
      return t("stepType.emit");
    default:
      return getCustomStepLabel(type) ?? `${type.charAt(0).toUpperCase()}${type.slice(1)}`;
  }
}
