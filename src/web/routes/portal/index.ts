/**
 * Portal API (`/api/portal/*`): the only business API portal accounts can
 * reach. Split per portal module; v1 has human tasks and the shared event
 * stream.
 *
 * @module
 */

import type { HitlService } from "@src/hitl";
import { Elysia } from "elysia";
import type { PortalEventHub } from "../../portalEvents";
import { portalEventRoutes } from "./events";
import { portalTaskRoutes } from "./tasks";

/**
 * Creates all portal routes.
 *
 * @param getService - Getter for the HITL service
 * @param getHub - Getter for the portal event hub
 * @returns Elysia plugin
 */
export function portalRoutes(getService: () => HitlService | undefined, getHub: () => PortalEventHub | undefined) {
  return new Elysia().use(portalTaskRoutes(getService)).use(portalEventRoutes(getHub));
}
