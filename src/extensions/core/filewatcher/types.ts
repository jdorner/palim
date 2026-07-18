/**
 * Shared types for the filewatcher extension.
 */

/** All supported file watcher event types. */
export const ALL_WATCHER_EVENT_TYPES = ["new", "change", "delete"] as const;

/** File system event types that a watcher can subscribe to. */
export type FileWatcherEventType = (typeof ALL_WATCHER_EVENT_TYPES)[number];

/** A persisted file watcher registration. */
export interface FileWatcherRegistration {
  /** URL-safe slug - used as the trigger ref in workflow YAML. */
  slug: string;
  /** Human-readable label. */
  name: string;
  /** Directory path relative to WORK_DIR (e.g. "inbox"). */
  path: string;
  /** Glob patterns for filename matching (e.g. ["*.png", "*.pdf"]). */
  patterns: string[];
  /** File system event types to watch for (e.g. ["new", "change"]). */
  events: FileWatcherEventType[];
  /** Whether to watch subdirectories recursively. */
  recursive: boolean;
  /** Whether to emit events for files already present when the watcher starts. */
  processExisting: boolean;
  /** Whether this watcher is active. */
  enabled: boolean;
  /** Creation timestamp (ms). */
  createdAt: number;
}
