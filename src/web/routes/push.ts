/**
 * Push route - thin HTTP wrapper over the push service.
 * Accepts out-of-band messages from sandbox scripts and delegates to
 * the programmatic push API.
 *
 * Handles `POST /api/push`.
 */

import { ROLE_SYSTEM } from "@shared/auth";
import { Type } from "@sinclair/typebox";
import type { ResolvedPrincipal } from "@src/auth";
import type { PushMessageFn } from "@src/push";
import { getSessionStore } from "@src/session";
import { Elysia } from "elysia";
import { getPrincipal } from "../auth";

/**
 * Decides whether a principal may push into a session.
 *
 * A session belongs to its user; one without a user (Telegram chats, workflow
 * runs nobody started) belongs to background work, which runs as the `system`
 * account. Admins may push anywhere.
 *
 * @param principal - The caller
 * @param sessionUserId - The session's owner, or null for an ownerless session
 * @returns Whether the push is allowed
 */
function mayPush(principal: ResolvedPrincipal, sessionUserId: string | null): boolean {
  if (principal.isAdmin) return true;
  if (sessionUserId === null) return principal.user.roles.includes(ROLE_SYSTEM);
  return principal.user.id === sessionUserId;
}

/**
 * Creates the push route group.
 *
 * @param pushMessage - The programmatic push function from the push service
 * @returns Elysia plugin with push routes
 */
export function pushRoutes(pushMessage: PushMessageFn) {
  return new Elysia().post(
    "/api/push",
    async ({ body, request, status }) => {
      const { sessionId, content, contentType: rawContentType } = body;
      const contentType = rawContentType ?? "text/markdown";

      const principal = getPrincipal(request);
      if (!principal) return status(401, { error: "Unauthorized" });

      // Answer 404 for other users' sessions too, so callers cannot probe for them.
      const session = getSessionStore().get(sessionId);
      if (!session || !mayPush(principal, session.userId)) {
        return status(404, { error: "Session not found" });
      }

      try {
        const result = pushMessage(sessionId, content, { contentType });
        return status(result.status === "broadcast" ? 202 : 200, { status: result.status });
      } catch (err) {
        // The session can be deleted between the lookup above and the push.
        if (err instanceof Error && err.message.startsWith("Session not found")) {
          return status(404, { error: "Session not found" });
        }
        throw err;
      }
    },
    {
      body: Type.Object({
        sessionId: Type.String({ minLength: 1, maxLength: 64 }),
        content: Type.String({ minLength: 1, maxLength: 32768 }),
        contentType: Type.Optional(Type.Union([Type.Literal("text/markdown"), Type.Literal("text/plain")])),
      }),
    },
  );
}
