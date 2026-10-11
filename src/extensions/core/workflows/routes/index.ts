/**
 * Registers all HTTP routes of the workflows extension.
 *
 * @module
 */

import { registerDefinitionsRoutes } from "./definitions";
import { registerMetaRoutes } from "./meta";
import { registerRunsRoutes } from "./runs";
import { registerSignalsRoutes } from "./signals";
import type { WorkflowRouteDeps } from "./types";

export type { WorkflowRouteDeps } from "./types";

/**
 * Registers the metadata, definition, run, and signal routes.
 *
 * @param deps - Shared extension state and services
 */
export function registerWorkflowRoutes(deps: WorkflowRouteDeps): void {
  registerMetaRoutes(deps);
  registerDefinitionsRoutes(deps);
  registerRunsRoutes(deps);
  registerSignalsRoutes(deps);
}
