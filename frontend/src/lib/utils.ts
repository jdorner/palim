import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Generates a UUID v4 string. Uses `crypto.randomUUID()` when available
 * (secure contexts). Falls back to a manual implementation
 * in non-secure contexts.
 * @returns A UUID v4 string
 */
export function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  // Fallback
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (+c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))).toString(16),
  );
}

export const formatter = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "medium" });

/**
 * Formats a Unix timestamp to a localized date/time string.
 * @param ts - Timestamp in milliseconds
 * @returns Formatted date/time string (de-DE locale)
 */
export function formatTimestamp(ts: number | null): string {
  if (!ts) return "Never";
  return formatter.format(ts);
}

/**
 * Maps a job/step/workflow status string to a Badge variant.
 * @param status - Status string (e.g. "active", "completed", "failed")
 * @returns Badge variant name
 */
export function statusVariant(
  status: string,
): "default" | "secondary" | "destructive" | "success" | "warning" | "outline" {
  const map: Record<string, "default" | "secondary" | "destructive" | "success" | "warning"> = {
    pending: "secondary",
    waiting: "secondary",
    queued: "secondary",
    active: "default",
    running: "default",
    completed: "success",
    failed: "destructive",
    delayed: "warning",
  };
  return map[status] ?? "secondary";
}

export interface AutomationStyle {
  /** Tailwind text color class for the automation type label. */
  color: string;
  /** Tailwind background color class for indicators (dots, badges). */
  bg: string;
  /** Tailwind border color class for indicators. */
  border: string;
  /** Phosphor icon component name hint (for reference). */
  icon: "timer" | "eye" | "link" | "flow" | "chat" | "cursor" | "default";
}

/**
 * Returns color and icon metadata for an automation type.
 * Colors use darker shades for light mode and lighter shades for dark mode.
 * @param type - Automation type string (e.g. "schedule", "filewatcher", "webhook", "workflow", "chat", "manual")
 * @returns Style metadata for rendering the automation type
 */
export function automationStyle(type: string): AutomationStyle {
  switch (type) {
    case "schedule":
    case "scheduler":
      return {
        color: "text-blue-500 dark:text-blue-300",
        bg: "bg-blue-500 dark:bg-blue-300",
        border: "border-blue-500 dark:border-blue-300",
        icon: "timer",
      };
    case "filewatcher":
      return {
        color: "text-amber-500 dark:text-amber-300",
        bg: "bg-amber-500 dark:bg-amber-300",
        border: "border-amber-500 dark:border-amber-300",
        icon: "eye",
      };
    case "webhook":
      return {
        color: "text-emerald-500 dark:text-emerald-300",
        bg: "bg-emerald-500 dark:bg-emerald-300",
        border: "border-emerald-500 dark:border-emerald-300",
        icon: "link",
      };
    case "workflow":
      return {
        color: "text-violet-500 dark:text-violet-300",
        bg: "bg-violet-500 dark:bg-violet-300",
        border: "border-violet-500 dark:border-violet-300",
        icon: "flow",
      };
    case "chat":
      return {
        color: "text-red-500 dark:text-red-300",
        bg: "bg-red-500 dark:bg-red-300",
        border: "border-red-500 dark:border-red-300",
        icon: "chat",
      };
    case "manual":
      return {
        color: "text-fuchsia-400 dark:text-fuchsia-300",
        bg: "bg-fuchsia-400 dark:bg-fuchsia-300",
        border: "border-fuchsia-400 dark:border-fuchsia-300",
        icon: "cursor",
      };
    case "mcp":
      return {
        color: "text-violet-600 dark:text-violet-500",
        bg: "bg-violet-600 dark:bg-violet-500",
        border: "border-violet-600 dark:border-violet-500",
        icon: "cursor",
      };
    default:
      return {
        color: "text-muted-foreground",
        bg: "bg-muted-foreground",
        border: "border-muted-foreground",
        icon: "default",
      };
  }
}

/**
 * Checks whether a job status allows cancellation.
 * @param status - Job status string
 * @returns true if the job can be cancelled
 */
export function isJobCancellable(status: string): boolean {
  return status === "active" || status === "waiting" || status === "delayed" || status === "failed";
}

/**
 * Checks whether a workflow run status allows cancellation.
 * @param status - Workflow run status string
 * @returns true if the run can be cancelled
 */
export function isRunCancellable(status: string): boolean {
  return (
    status === "active" || status === "running" || status === "waiting" || status === "queued" || status === "failed"
  );
}

/**
 * Normalizes a single step status into the canonical vocabulary used by
 * {@link aggregateStepStatus} and the status indicators (`StatusDot`).
 *
 * Step statuses reach the frontend in two vocabularies:
 * - Backend DAG runs (serialized from the run store) report
 *   "pending" | "running" | "completed" | "failed" | "dead".
 * - The graph renderer / WS store use
 *   "waiting" | "active" | "completed" | "failed" | "waiting-signal" | "skipped".
 *
 * This maps both onto a single set so aggregation and dot coloring behave the
 * same regardless of the source (e.g. the run list feeds raw DAG statuses,
 * where a live step is "running", not "active").
 *
 * @param status - Raw step status string.
 * @returns Canonical status string.
 */
function canonicalStepStatus(status: string): string {
  switch (status) {
    case "running":
      return "active";
    case "pending":
      return "waiting";
    case "dead":
      return "skipped";
    default:
      return status;
  }
}

/**
 * Computes an aggregate status from an array of step statuses.
 *
 * Priority: failed > waiting-signal > active > waiting/delayed > completed.
 *
 * Handles both status vocabularies (backend DAG "running"/"pending"/"dead" and
 * the graph "active"/"waiting"/"skipped") by normalizing each step first, so a
 * running run aggregates to "active" (blinking blue dot) and a finished run
 * that took a branch aggregates to "completed" (green dot).
 *
 * Steps that are "dead"/"skipped" (branches that were not taken in a
 * control-flow workflow) are ignored: they neither block completion nor count
 * as active work. A run is "completed" when every non-dead/non-skipped step is
 * completed, which mirrors the backend's run-completion rule where dead
 * branches do not prevent a run from finishing.
 *
 * @param steps - Array of step statuses
 * @returns Aggregated status string
 */
export function aggregateStepStatus(steps: Array<{ status: string }>): string {
  const statuses = steps.map((s) => canonicalStepStatus(s.status));
  if (statuses.some((s) => s === "failed")) return "failed";
  if (statuses.some((s) => s === "waiting-signal")) return "waiting-signal";
  if (statuses.some((s) => s === "active")) return "active";
  if (statuses.some((s) => s === "waiting" || s === "delayed")) return "waiting";
  // Dead/skipped steps (not-taken branches) do not block completion.
  const liveSteps = statuses.filter((s) => s !== "skipped");
  if (liveSteps.length > 0 && liveSteps.every((s) => s === "completed")) return "completed";
  return "unknown";
}
