/**
 * Extension lifecycle operations.
 *
 * Extracted from ExtensionRegistry to consolidate the repeated patterns of
 * "create context, call initialize, handle partial cleanup on failure" and
 * "shutdown, tear down registrations". The registry delegates to these
 * functions while retaining ownership of state (loaded list, global sets).
 *
 * @module
 */

import type { WebSocketMessage } from "@shared/types";
import type { ManagedQueuePort } from "@src/queue";
import createLogger from "logging";
import type { LoadedExtension } from "../internalTypes";
import type { Extension } from "../types";
import type { EventBus } from "./eventBus";
import type { ExtensionContextDeps } from "./extensionContext";
import { createExtensionContext } from "./extensionContext";

const logger = createLogger("ExtensionRegistry");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Mutable entry in the registry's loaded list (passed by reference). */
export type LoadedEntry = { name: string } & LoadedExtension;

/** Subset of registry state needed by lifecycle operations. */
export interface LifecycleState {
  /** Global tool name set — prevents duplicates across extensions and core. */
  toolNameSet: Set<string>;
  /** Global route key set — "METHOD:/full/path". */
  routeKeySet: Set<string>;
  /** Global step type name set — prevents duplicates across extensions. */
  stepTypeNameSet: Set<string>;
  /** Route prefixes for unloaded extensions — checked by the web server route guard. */
  disabledRoutePrefixes: Set<string>;
  /** The shared event bus instance. */
  eventBus: EventBus;
}

/** Dependencies needed to build an ExtensionContext during activation. */
export interface ActivationDeps {
  /** Builds the full dependency set for createExtensionContext. */
  buildContextDeps: (extensionName: string, ext: Extension) => ExtensionContextDeps;
  /** Broadcast a WebSocket message to all connected clients. */
  broadcastFn: (message: WebSocketMessage) => void;
  /** Callback invoked when an extension creates a queue during loading. */
  onQueueCreated?: (queue: ManagedQueuePort) => void;
}

// ---------------------------------------------------------------------------
// Cleanup helper (shared by deactivate, shutdownAll, and init-failure paths)
// ---------------------------------------------------------------------------

/**
 * Tears down all registrations for a loaded extension entry.
 *
 * Removes tools, step types, and route keys from the global sets,
 * unsubscribes events, and closes queues. Does NOT call `shutdown()`
 * on the extension itself — callers handle that separately.
 *
 * @param entry - The loaded extension entry to clean up
 * @param state - The shared registry state holding the global sets
 */
export async function cleanupRegistrations(entry: LoadedEntry, state: LifecycleState): Promise<void> {
  for (const tool of entry.tools) {
    state.toolNameSet.delete(tool.name);
  }
  for (const st of entry.stepTypes) {
    state.stepTypeNameSet.delete(st.type);
  }
  for (const route of entry.routes) {
    state.routeKeySet.delete(`${route.method}:${route.fullPath}`);
  }
  state.eventBus.unsubscribeAll(entry.name);

  for (const q of entry.queues) {
    try {
      await q.close();
    } catch (err) {
      logger.error(`Error closing queue for extension "${entry.name}":`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Activate
// ---------------------------------------------------------------------------

/**
 * Activate a suspended extension: creates a fresh ExtensionContext, calls
 * `initialize()`, wires registrations, and transitions to active state.
 *
 * This function consolidates the duplicated pattern previously found in
 * both `initializeExtension` and `activate` on the registry class.
 *
 * @param entry - The loaded extension entry (mutated in-place on success)
 * @param state - The shared registry state
 * @param deps - Dependencies for building the extension context
 * @throws If `initialize()` fails (partial registrations are cleaned up first)
 */
export async function activateExtension(
  entry: LoadedEntry,
  state: LifecycleState,
  deps: ActivationDeps,
): Promise<void> {
  // No-op if already active
  if (entry.state === "active") return;

  const ext = entry.extension;
  const name = entry.name;

  const contextDeps = deps.buildContextDeps(name, ext);
  const { context, loaded } = createExtensionContext(contextDeps);

  try {
    await ext.initialize(context);
  } catch (err) {
    // Partial registration cleanup on failed initialize
    await cleanupPartialRegistrations(loaded, state, name);
    entry.error = err instanceof Error ? err.message : String(err);
    throw err;
  }

  // Update the loaded entry with new registrations
  entry.tools = loaded.tools;
  entry.routes = loaded.routes;
  entry.queues = loaded.queues;
  entry.stepTypes = loaded.stepTypes;
  entry.state = "active";
  entry.error = null;

  // Remove from disabled route prefixes
  state.disabledRoutePrefixes.delete(`/ext/${name}`);

  // Notify monitor about any queues created
  if (deps.onQueueCreated) {
    for (const mq of loaded.queues) {
      deps.onQueueCreated(mq);
    }
  }

  // Broadcast lifecycle event
  deps.broadcastFn({
    type: "extension_lifecycle",
    action: "activated",
    name,
    version: ext.manifest.version,
  });

  logger.info(`Activated extension "${name}" v${ext.manifest.version}`);
}

// ---------------------------------------------------------------------------
// Deactivate
// ---------------------------------------------------------------------------

/**
 * Deactivate a loaded extension: calls `shutdown()`, tears down all
 * registrations (tools, routes, queues, events), and transitions to
 * suspended state. The extension remains in the loaded list for
 * re-activation later.
 *
 * No-op if the extension is already suspended.
 *
 * @param entry - The loaded extension entry (mutated in-place)
 * @param state - The shared registry state
 * @param broadcastFn - Optional function to broadcast lifecycle events
 */
export async function deactivateExtension(
  entry: LoadedEntry,
  state: LifecycleState,
  broadcastFn?: (message: WebSocketMessage) => void,
): Promise<void> {
  if (entry.state === "suspended") return;

  const name = entry.name;

  // Shutdown the extension (errors are logged but don't prevent cleanup)
  try {
    await entry.extension.shutdown();
    logger.debug(`Shut down extension "${name}"`);
  } catch (err) {
    logger.error(`Error shutting down extension "${name}":`, err);
  }

  // Clean up all registrations
  await cleanupRegistrations(entry, state);
  state.disabledRoutePrefixes.add(`/ext/${name}`);

  // Clear registrations and transition to suspended
  entry.tools = [];
  entry.routes = [];
  entry.queues = [];
  entry.stepTypes = [];
  entry.state = "suspended";

  // Broadcast lifecycle event
  if (broadcastFn) {
    broadcastFn({
      type: "extension_lifecycle",
      action: "deactivated",
      name,
      version: entry.extension.manifest.version,
    });
  }

  logger.info(`Deactivated extension "${name}"`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Clean up partial registrations from a failed `initialize()` call.
 * Called when the extension's initialize method throws before completing.
 */
async function cleanupPartialRegistrations(
  loaded: Omit<LoadedExtension, "extension">,
  state: LifecycleState,
  name: string,
): Promise<void> {
  for (const tool of loaded.tools) {
    state.toolNameSet.delete(tool.name);
  }
  for (const st of loaded.stepTypes) {
    state.stepTypeNameSet.delete(st.type);
  }
  for (const route of loaded.routes) {
    state.routeKeySet.delete(`${route.method}:${route.fullPath}`);
  }
  state.eventBus.unsubscribeAll(name);
  for (const q of loaded.queues) {
    try {
      await q.close();
    } catch {
      // Ignore cleanup errors
    }
  }
}
