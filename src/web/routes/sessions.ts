/**
 * Session routes - provides REST endpoints for session inspection.
 *
 * Handles:
 * - `GET    /api/sessions/:id/messages`
 * - `DELETE /api/sessions/:id/messages`
 * - `DELETE /api/sessions/:id`
 *
 * Note: Skill request routes are defined in `src/jobs/skillRequestQueue.ts`.
 */

import { Type } from "@sinclair/typebox";
import { ownedSubject } from "@src/auth";
import { getSessionStore } from "@src/session";
import { mainLogger as log } from "@src/utils/logger";
import { Elysia } from "elysia";
import { getPrincipal } from "../auth";

/**
 * Guard: resolves a session and enforces ownership.
 *
 * Returns a 404 when the session does not exist, or a 403 when the requesting
 * principal may not act on it (a non-admin accessing another user's session).
 * On success returns undefined and the caller may proceed.
 *
 * @param sessionStore - The session store.
 * @param sessionId - The session id.
 * @param request - The incoming request (carries the resolved principal).
 * @param action - The CASL action being attempted ("read", "update", "delete").
 * @param status - Elysia status helper.
 * @returns A 404/403 response, or undefined when access is allowed.
 */
function requireOwnedSession(
  sessionStore: ReturnType<typeof getSessionStore>,
  sessionId: string,
  request: Request,
  action: "read" | "update" | "delete",
  status: any,
) {
  const session = sessionStore.get(sessionId);
  if (!session) {
    return status(404, { error: "Session not found" });
  }
  const principal = getPrincipal(request);
  if (!principal) {
    return status(401, { error: "Unauthorized" });
  }
  const allowed = principal.ability.can(action, ownedSubject("Session", { userId: session.userId }));
  if (!allowed) {
    // Do not reveal existence to non-owners: respond 404.
    return status(404, { error: "Session not found" });
  }
}

/**
 * Creates the session route group.
 *
 * @returns Elysia plugin with session routes
 */
export function sessionRoutes() {
  return new Elysia()
    .get(
      "/api/sessions/:id/messages",
      ({ params, query, request, status }) => {
        try {
          const sessionStore = getSessionStore();
          const denied = requireOwnedSession(sessionStore, params.id, request, "read", status);
          if (denied) return denied;

          const messages = sessionStore.getMessages(params.id, {
            ...(query.limit !== undefined ? { limit: query.limit } : {}),
            ...(query.offset !== undefined ? { offset: query.offset } : {}),
          });

          return { sessionId: params.id, messages };
        } catch (error) {
          log.error("Failed to fetch session messages", { error, sessionId: params.id });
          return status(500, { error: "Failed to fetch session messages" });
        }
      },
      {
        query: Type.Object({
          limit: Type.Optional(Type.Number({ minimum: 1, description: "Maximum number of messages to return" })),
          offset: Type.Optional(Type.Number({ minimum: 0, description: "Number of messages to skip" })),
        }),
      },
    )
    .delete(
      "/api/sessions/:id/messages",
      ({ params, query, request, status }) => {
        try {
          const sessionStore = getSessionStore();
          const denied = requireOwnedSession(sessionStore, params.id, request, "update", status);
          if (denied) return denied;

          const keepTurns = query.keep ?? 0;
          const includeTrailing = query.includeTrailing === "true";

          if (keepTurns > 0 || includeTrailing) {
            // A "turn" = a user message plus all following non-user messages
            // (assistant, toolResult, etc.) until the next user message.
            // `keepTurns` means: keep the first N complete turns.
            // `includeTrailing` means: also keep the user message that starts
            // the next turn (without its response).
            const messages = sessionStore.getMessages(params.id);
            let turnsSeen = 0;
            let cutIndex = messages.length; // default: keep all

            for (let i = 0; i < messages.length; i++) {
              if (messages[i]?.role === "user") {
                turnsSeen++;

                if (includeTrailing && turnsSeen === keepTurns + 1) {
                  // Keep this user message but nothing after it
                  cutIndex = i + 1;
                  break;
                }

                if (turnsSeen > keepTurns && !includeTrailing) {
                  // Cut before this user message (don't include it)
                  cutIndex = i;
                  break;
                }
              }
            }

            const toKeep = messages.slice(0, cutIndex);
            sessionStore.replaceMessages(params.id, toKeep);
          } else {
            // Clear all messages
            sessionStore.replaceMessages(params.id, []);
          }

          return status(200, { sessionId: params.id, ok: true });
        } catch (error) {
          log.error("Failed to truncate session messages", { error, sessionId: params.id });
          return status(500, { error: "Failed to truncate session messages" });
        }
      },
      {
        query: Type.Object({
          keep: Type.Optional(
            Type.Number({
              minimum: 0,
              description:
                "Number of complete turns to keep (a turn = user message + all following assistant/tool messages until the next user message)",
            }),
          ),
          includeTrailing: Type.Optional(
            Type.String({
              description: "If 'true', also keep the user message starting the next turn (without its response)",
            }),
          ),
        }),
      },
    )
    .delete("/api/sessions/:id", ({ params, request, status }) => {
      try {
        const sessionStore = getSessionStore();
        const denied = requireOwnedSession(sessionStore, params.id, request, "delete", status);
        if (denied) return denied;

        sessionStore.delete(params.id);

        return status(200, { sessionId: params.id, ok: true });
      } catch (error) {
        log.error("Failed to delete session", { error, sessionId: params.id });
        return status(500, { error: "Failed to delete session" });
      }
    });
}
