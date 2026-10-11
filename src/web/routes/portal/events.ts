/**
 * Portal event stream route: `GET /api/portal/events` (server-sent events).
 *
 * The client authenticates with the usual bearer header (read the stream with
 * `fetch`, since `EventSource` cannot send headers). See {@link PortalEventHub}
 * for what is delivered.
 *
 * @module
 */

import { Elysia } from "elysia";
import { extractBearerToken, getPrincipal } from "../../auth";
import type { PortalEventHub } from "../../portalEvents";

/**
 * Creates the portal event stream route.
 *
 * @param getHub - Getter for the event hub (undefined during startup)
 * @returns Elysia plugin
 */
export function portalEventRoutes(getHub: () => PortalEventHub | undefined) {
  return new Elysia().get("/api/portal/events", ({ request, status }) => {
    const hub = getHub();
    const principal = getPrincipal(request);
    if (!hub) return status(503, { error: "Human tasks unavailable" });
    if (!principal) return status(401, { error: "Unauthorized" });
    return hub.connect(extractBearerToken(request.headers.get("authorization")), principal);
  });
}
