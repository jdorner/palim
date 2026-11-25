/**
 * Workflow trigger types for the editor: the built-in ones plus those that
 * enabled extensions register (`ui.triggerTypes` in the extension list), with
 * labels translated through the owning extension's catalog
 * (`triggers.<type>.label` / `triggers.<type>.description`).
 */

import BellRingingIcon from "phosphor-svelte/lib/BellRingingIcon";
import type { Component } from "svelte";
import { get } from "svelte/store";
import type { ExtensionInfo, TriggerTypeInfo } from "$shared/extensions";
import { triggerRefMode as sharedTriggerRefMode } from "$shared/workflows";
import { extensions } from "./extensionStore";
import { type CoreKey, translateCore, translateExtension } from "./i18nCore";
import { resolveIcon } from "./iconRegistry";

/** Built-in trigger types in the order the trigger type picker lists them. */
const BUILTIN_PICKER_ORDER = ["webhook", "schedule", "manual", "filewatcher", "portal"] as const;

/**
 * Returns the trigger types registered by enabled extensions, with label and
 * description translated.
 *
 * @param list - The extension list; pass `$extensions` in components so they update with it
 * @returns The extension trigger types, sorted by label
 */
export function extensionTriggerTypes(list: ExtensionInfo[] = get(extensions)): TriggerTypeInfo[] {
  const types: TriggerTypeInfo[] = [];
  for (const ext of list) {
    if (!ext.enabled || !ext.ui?.triggerTypes) continue;
    for (const info of ext.ui.triggerTypes) {
      types.push({
        ...info,
        label: translateExtension(ext.name, `triggers.${info.type}.label`, info.label),
        description:
          info.description === undefined
            ? undefined
            : translateExtension(ext.name, `triggers.${info.type}.description`, info.description),
      });
    }
  }
  return types.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Looks up an extension trigger type by name.
 *
 * @param type - The trigger type
 * @param list - The extension list (defaults to the store's current value)
 * @returns The translated trigger type, or undefined for built-in or unregistered types
 */
export function extensionTriggerType(type: string, list?: ExtensionInfo[]): TriggerTypeInfo | undefined {
  return extensionTriggerTypes(list).find((info) => info.type === type);
}

/**
 * Returns the trigger types the editor offers: the built-in ones, then the
 * extension ones.
 *
 * @param list - The extension list (defaults to the store's current value)
 * @returns Trigger type names in picker order
 */
export function triggerTypeOptions(list?: ExtensionInfo[]): string[] {
  return [...BUILTIN_PICKER_ORDER, ...extensionTriggerTypes(list).map((info) => info.type)];
}

/**
 * Returns the short label of a trigger type (e.g. "webhook", or an
 * extension's "Extension update"); the type name itself when it is unknown.
 *
 * @param type - The trigger type
 * @param list - The extension list (defaults to the store's current value)
 * @returns The display label
 */
export function triggerTypeLabel(type: string, list?: ExtensionInfo[]): string {
  const ext = extensionTriggerType(type, list);
  if (ext) return ext.label;
  return translateCore(`triggerTypes.${type}` as CoreKey, { default: type });
}

/**
 * How a trigger type takes a `ref` (the shared rule, with the registered
 * extension types).
 *
 * @param type - The trigger type
 * @param list - The extension list (defaults to the store's current value)
 * @returns `required`, `none`, or `unknown` (no enabled extension registers the type)
 */
export function triggerRefMode(type: string, list?: ExtensionInfo[]): "required" | "none" | "unknown" {
  return sharedTriggerRefMode(type, (t) => extensionTriggerType(t, list));
}

/**
 * Icon of a trigger type registered by an extension: the icon it registered,
 * else a generic bell (also for a type no enabled extension registers).
 *
 * @param iconId - The registered icon id, if any
 * @returns The icon component
 */
export function extensionTriggerIcon(iconId?: string): Component {
  return (iconId && resolveIcon(iconId)) || BellRingingIcon;
}

/**
 * Text/icon color of a trigger type registered by an extension: the color of
 * the extension's own navigation icon, so the trigger matches its extension.
 *
 * @param type - The trigger type
 * @param list - The extension list; pass `$extensions` in components so they update with it
 * @returns Tailwind color classes, or undefined when the type is not registered or its extension has no colored navigation icon
 */
export function extensionTriggerColor(type: string, list: ExtensionInfo[] = get(extensions)): string | undefined {
  const owner = extensionTriggerType(type, list)?.extensionName;
  const ext = owner ? list.find((e) => e.name === owner) : undefined;
  return ext?.ui?.navigation?.find((item) => item.iconColor)?.iconColor;
}
