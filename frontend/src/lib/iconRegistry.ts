import ChatTextIcon from "phosphor-svelte/lib/ChatTextIcon";
import ClockIcon from "phosphor-svelte/lib/ClockIcon";
import EyeIcon from "phosphor-svelte/lib/EyeIcon";
import FlowArrowIcon from "phosphor-svelte/lib/FlowArrowIcon";
import GearIcon from "phosphor-svelte/lib/GearIcon";
import LinkIcon from "phosphor-svelte/lib/LinkIcon";
import PlugIcon from "phosphor-svelte/lib/PlugIcon";
import TrayIcon from "phosphor-svelte/lib/TrayIcon";
import type { Component } from "svelte";

/** Maps icon string identifiers from extension manifests to Svelte components. */
export const iconRegistry: Record<string, Component> = {
  ChatTextIcon,
  ClockIcon,
  EyeIcon,
  FlowArrowIcon,
  GearIcon,
  LinkIcon,
  PlugIcon,
  TrayIcon,
};

/**
 * Resolves an icon identifier to a Svelte component.
 * Returns null if the identifier is not registered.
 */
export function resolveIcon(iconId: string): Component | null {
  return iconRegistry[iconId] ?? null;
}
