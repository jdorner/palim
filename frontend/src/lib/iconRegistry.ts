import BroadcastIcon from "phosphor-svelte/lib/BroadcastIcon";
import ChatTextIcon from "phosphor-svelte/lib/ChatTextIcon";
import ClockIcon from "phosphor-svelte/lib/ClockIcon";
import DatabaseIcon from "phosphor-svelte/lib/DatabaseIcon";
import EnvelopeIcon from "phosphor-svelte/lib/EnvelopeIcon";
import EyeIcon from "phosphor-svelte/lib/EyeIcon";
import FileTextIcon from "phosphor-svelte/lib/FileTextIcon";
import FlowArrowIcon from "phosphor-svelte/lib/FlowArrowIcon";
import GearIcon from "phosphor-svelte/lib/GearIcon";
import GlobeIcon from "phosphor-svelte/lib/GlobeIcon";
import LinkIcon from "phosphor-svelte/lib/LinkIcon";
import PaperPlaneTiltIcon from "phosphor-svelte/lib/PaperPlaneTiltIcon";
import PlugIcon from "phosphor-svelte/lib/PlugIcon";
import ProhibitIcon from "phosphor-svelte/lib/ProhibitIcon";
import ReceiptIcon from "phosphor-svelte/lib/ReceiptIcon";
import RepeatIcon from "phosphor-svelte/lib/RepeatIcon";
import RobotIcon from "phosphor-svelte/lib/RobotIcon";
import StackIcon from "phosphor-svelte/lib/StackIcon";
import TableIcon from "phosphor-svelte/lib/TableIcon";
import TerminalWindowIcon from "phosphor-svelte/lib/TerminalWindowIcon";
import TrayIcon from "phosphor-svelte/lib/TrayIcon";
import type { Component } from "svelte";
import type { StepIconName } from "../../../shared/extensions";

/**
 * Maps icon string identifiers to Svelte (phosphor) components.
 *
 * Used both for extension sidebar navigation icons (declared in the manifest
 * `ui.navigation[].icon`) and for custom workflow step type icons (declared in
 * a `StepTypeHandler.icon`). In both cases the identifier is a key into this
 * registry, NOT an emoji or arbitrary string.
 *
 * The step-icon subset is keyed by {@link StepIconName} (the shared source of
 * truth), so adding a name to `STEP_ICON_NAMES` without a matching component
 * here is a compile error. Extra keys beyond the step-icon set are permitted
 * for navigation-only icons (e.g. GlobeIcon).
 */
export const iconRegistry: Record<StepIconName, Component> & Record<string, Component> = {
  BroadcastIcon,
  ChatTextIcon,
  ClockIcon,
  DatabaseIcon,
  EnvelopeIcon,
  EyeIcon,
  FileTextIcon,
  FlowArrowIcon,
  GearIcon,
  LinkIcon,
  PaperPlaneTiltIcon,
  PlugIcon,
  ProhibitIcon,
  ReceiptIcon,
  RepeatIcon,
  RobotIcon,
  StackIcon,
  TableIcon,
  TerminalWindowIcon,
  TrayIcon,
  GlobeIcon,
};

/**
 * Resolves an icon identifier to a Svelte component.
 * Returns null if the identifier is not registered.
 *
 * @param iconId - The registry key (e.g. "RobotIcon")
 * @returns The phosphor component, or null when the key is not registered
 */
export function resolveIcon(iconId: string): Component | null {
  return iconRegistry[iconId] ?? null;
}
