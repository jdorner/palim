/**
 * Portal API (`/api/portal/*`): the only business API portal accounts can
 * reach. Split per portal module: human tasks, workflow launchers, and the
 * shared event stream.
 *
 * @module
 */

import type { HitlService } from "@src/hitl";
import type { PortalLauncherRegistry } from "@src/portal";
import { Elysia } from "elysia";
import type { PortalEventHub } from "../../portalEvents";
import { portalEventRoutes } from "./events";
import { portalTaskRoutes } from "./tasks";
import { portalWorkflowRoutes } from "./workflows";

/**
 * Creates all portal routes.
 *
 * @param getService - Getter for the HITL service
 * @param getHub - Getter for the portal event hub
 * @param getLaunchers - Getter for the workflow launcher registry
 * @returns Elysia plugin
 */
export function portalRoutes(
  getService: () => HitlService | undefined,
  getHub: () => PortalEventHub | undefined,
  getLaunchers: () => PortalLauncherRegistry | undefined,
) {
  return new Elysia()
    .use(portalTaskRoutes(getService))
    .use(portalWorkflowRoutes(getLaunchers))
    .use(portalEventRoutes(getHub));
}
