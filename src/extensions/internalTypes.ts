/**
 * Internal extension system types - used by the registry and context factory.
 * These are NOT part of the public extension author API.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ManagedQueuePort } from "@src/queue";
import type { Extension, HttpMethod, RouteHandler } from "./types";

/** A route registered by an extension (includes the fully-qualified path). */
export interface RegisteredRoute {
  method: HttpMethod;
  /** Full path including the /ext/{extensionName}/ prefix. */
  fullPath: string;
  handler: RouteHandler;
}

/** Runtime lifecycle state of a loaded extension. */
export type ExtensionState = "active" | "suspended";

/** Tracks everything a single loaded extension has registered. */
export interface LoadedExtension {
  extension: Extension;
  tools: AgentTool[];
  routes: RegisteredRoute[];
  queues: ManagedQueuePort[];
  /** Absolute path to the extension's index.ts module (used for reload). */
  modulePath?: string;
  /** Current lifecycle state. Active extensions have live registrations; suspended ones do not. */
  state: ExtensionState;
  /** Error message from the last failed initialization attempt, or null if healthy. */
  error?: string | null;
}
