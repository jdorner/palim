/**
 * Shared visual metadata for workflow graph nodes.
 *
 * Provides a single source of truth for the icon component and category accent
 * color used to render each step type in the n8n-style node cards. Both the
 * step node, control-flow node, and wait-for node components resolve their
 * icon tile color and glyph from here so the look stays consistent.
 */

import ArrowsSplitIcon from "phosphor-svelte/lib/ArrowsSplitIcon";
import BroadcastIcon from "phosphor-svelte/lib/BroadcastIcon";
import ClockIcon from "phosphor-svelte/lib/ClockIcon";
import EyeIcon from "phosphor-svelte/lib/EyeIcon";
import GearIcon from "phosphor-svelte/lib/GearIcon";
import GitBranchIcon from "phosphor-svelte/lib/GitBranchIcon";
import LightningIcon from "phosphor-svelte/lib/LightningIcon";
import LinkIcon from "phosphor-svelte/lib/LinkIcon";
import PauseIcon from "phosphor-svelte/lib/PauseIcon";
import RobotIcon from "phosphor-svelte/lib/RobotIcon";
import StackIcon from "phosphor-svelte/lib/StackIcon";
import TrayIcon from "phosphor-svelte/lib/TrayIcon";
import type { Component } from "svelte";
import { resolveIcon } from "./iconRegistry";

/**
 * Node visual categories. Each maps to an accent color used for the icon tile
 * background and, subtly, the node's selection ring and handle color.
 */
export type NodeCategory = "trigger" | "agent" | "logic" | "action";

/** Tailwind classes for each category's icon tile (solid color, white glyph). */
const CATEGORY_TILE_CLASS: Record<NodeCategory, string> = {
  trigger: "bg-emerald-500",
  agent: "bg-violet-500",
  logic: "bg-sky-500",
  action: "bg-amber-500",
};

/** Visual descriptor resolved for a given step type. */
export interface NodeVisual {
  /** The phosphor icon component for the node's icon tile. */
  icon: Component;
  /** Tailwind class(es) for the icon tile background. */
  tileClass: string;
  /** The node's visual category. */
  category: NodeCategory;
}

/** Built-in step type to icon + category mapping. */
const BUILTIN: Record<string, { icon: Component; category: NodeCategory }> = {
  trigger: { icon: LightningIcon, category: "trigger" },
  agent: { icon: RobotIcon, category: "agent" },
  if: { icon: ArrowsSplitIcon, category: "logic" },
  case: { icon: GitBranchIcon, category: "logic" },
  iterator: { icon: StackIcon, category: "logic" },
  aggregator: { icon: TrayIcon, category: "logic" },
  waitFor: { icon: PauseIcon, category: "logic" },
  emit: { icon: BroadcastIcon, category: "logic" },
};

/** Trigger subtype to icon mapping (falls back to the generic lightning). */
const TRIGGER_ICONS: Record<string, Component> = {
  webhook: LinkIcon,
  schedule: ClockIcon,
  manual: LightningIcon,
  filewatcher: EyeIcon,
};

/**
 * Resolves the icon component, tile color, and category for a workflow step type.
 *
 * Custom extension step types resolve their icon via the shared icon registry
 * when the extension provides a registered icon id; otherwise they fall back to
 * a generic gear glyph in the "action" category.
 *
 * @param type - The step type identifier (e.g. "agent", "if", "http-request").
 * @param opts - Optional extras: `triggerType` for trigger subtype icons,
 *   `iconId` for a custom extension icon registry lookup.
 * @returns The resolved node visual descriptor.
 */
export function visualForStepType(
  type: string,
  opts: { triggerType?: string; iconId?: string; category?: string } = {},
): NodeVisual {
  if (type === "trigger") {
    const icon = (opts.triggerType && TRIGGER_ICONS[opts.triggerType]) || LightningIcon;
    return { icon, tileClass: CATEGORY_TILE_CLASS.trigger, category: "trigger" };
  }

  const builtin = BUILTIN[type];
  if (builtin) {
    return { icon: builtin.icon, tileClass: CATEGORY_TILE_CLASS[builtin.category], category: builtin.category };
  }

  // Custom extension step type: use its registered icon when available. The
  // accent color follows the declared palette category - control-flow types
  // (e.g. for-each) share the "logic" (sky) accent with built-in CF nodes,
  // while the default action group stays amber.
  const customIcon = opts.iconId ? resolveIcon(opts.iconId) : null;
  const category: NodeCategory = opts.category === "control-flow" ? "logic" : "action";
  return {
    icon: customIcon ?? GearIcon,
    tileClass: CATEGORY_TILE_CLASS[category],
    category,
  };
}

// ---------------------------------------------------------------------------
// Status visuals
// ---------------------------------------------------------------------------

import CheckCircleIcon from "phosphor-svelte/lib/CheckCircleIcon";
import CircleIcon from "phosphor-svelte/lib/CircleIcon";
import SpinnerGapIcon from "phosphor-svelte/lib/SpinnerGapIcon";
import XCircleIcon from "phosphor-svelte/lib/XCircleIcon";

/** Graph node status vocabulary (mirrors workflowRunStatus.GraphStepStatus). */
export type NodeStatus = "waiting" | "active" | "completed" | "failed" | "waiting-signal" | "skipped";

/** Visual descriptor for a node status badge. */
export interface StatusVisual {
  /** Icon component for the status badge, or null when no badge should show. */
  icon: Component | null;
  /** Tailwind text color class for the badge icon. */
  colorClass: string;
  /** Whether the badge icon should spin (active/running state). */
  spin: boolean;
  /** Tailwind ring color class applied to the node card for this status. */
  ringClass: string;
}

/** Maps a node status to its badge icon, colors, and card ring accent. */
const STATUS_VISUALS: Record<NodeStatus, StatusVisual> = {
  waiting: { icon: null, colorClass: "", spin: false, ringClass: "ring-transparent" },
  active: {
    icon: SpinnerGapIcon,
    colorClass: "text-yellow-500",
    spin: true,
    ringClass: "ring-yellow-400/70",
  },
  completed: {
    icon: CheckCircleIcon,
    colorClass: "text-emerald-500",
    spin: false,
    ringClass: "ring-emerald-400/60",
  },
  failed: { icon: XCircleIcon, colorClass: "text-red-500", spin: false, ringClass: "ring-red-400/70" },
  "waiting-signal": {
    icon: CircleIcon,
    colorClass: "text-amber-500",
    spin: false,
    ringClass: "ring-amber-400/70",
  },
  skipped: { icon: null, colorClass: "", spin: false, ringClass: "ring-transparent" },
};

/**
 * Resolves the status badge and card ring accent for a node status.
 *
 * @param status - The node's current graph status (defaults to "waiting").
 * @returns The status visual descriptor.
 */
export function statusVisual(status: NodeStatus = "waiting"): StatusVisual {
  return STATUS_VISUALS[status] ?? STATUS_VISUALS.waiting;
}
