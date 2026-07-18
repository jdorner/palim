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

import DOMPurify from "dompurify";
import { marked } from "marked";

export const formatter = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "medium" });

/**
 * Renders a markdown string to sanitized HTML.
 * @param text - Raw markdown text
 * @returns Sanitized HTML string
 */
export function renderMarkdown(text: string): string {
  try {
    const trimmed = text.trim();
    const html = marked.parse(trimmed, { breaks: true, gfm: true }) as string;
    return DOMPurify.sanitize(html);
  } catch (e) {
    console.error("Markdown render error:", e);
    return text;
  }
}

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
