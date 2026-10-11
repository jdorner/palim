/**
 * Portal modules: each feature area (human tasks, workflow launchers)
 * contributes navigation, routes, and live event handling. The shell renders
 * whatever the registered modules provide, so new modules plug in without
 * touching it.
 *
 * @module
 */

import type { Component } from "svelte";
import type { PortalEvent } from "$shared/portal";
import { launchModule } from "./launch";
import { tasksModule } from "./tasks";

/** A route of a module. */
export interface ModuleRoute {
  /** Path pattern with `:param` segments (e.g. "/tasks/:id"). */
  pattern: string;
  /** Page component; receives the route params. */
  component: Component<{ params: Record<string, string> }>;
}

/** A portal module. */
export interface PortalModule {
  /** Unique module id. */
  id: string;
  /** Navigation entry. */
  nav: {
    /** Start path of the module. */
    path: string;
    /** Translation key of the label. */
    labelKey: string;
    /** Icon component. */
    icon: Component;
    /** Badge count (0 hides the badge). */
    badge?: () => number;
  };
  /** Routes of the module. */
  routes: ModuleRoute[];
  /** Whether the signed-in user may use the module. */
  isAvailable: () => boolean;
  /** Handles a live event from `/api/portal/events`. */
  onEvent?: (event: PortalEvent) => void;
  /** Resets module state (on sign-out). */
  reset?: () => void;
}

/** All modules, in navigation order. */
export const MODULES: readonly PortalModule[] = [tasksModule, launchModule];
