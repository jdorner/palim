/**
 * Session routes - provides REST endpoints for session inspection.
 *
 * Handles:
 * - `GET    /api/sessions/:id/messages`
 * - `GET    /api/sessions/:id/usage`
 * - `DELETE /api/sessions/:id/messages`
 *
 * Note: Skill request routes are defined in `src/jobs/skillRequestQueue.ts`.
 */

import { Type } from "@sinclair/typebox";
import { getSessionStore } from "@src/session";
import { mainLogger as log } from "@src/utils/logger";
import { Elysia } from "elysia";

/**
 * Guard: returns a 404 response if the session doesn't exist.
 */
function requireSession(sessionStore: ReturnType<typeof getSessionStore>, sessionId: string, status: any) {
  if (!sessionStore.get(sessionId)) {
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
      ({ params, query, status }) => {
        try {
          const sessionStore = getSessionStore();
          const notFound = requireSession(sessionStore, params.id, status);
          if (notFound) return notFound;

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
    .get("/api/sessions/:id/usage", ({ params, status }) => {
      try {
        const sessionStore = getSessionStore();
        const session = sessionStore.get(params.id);
        if (!session) {
          return status(404, { error: "Session not found" });
        }

        return {
          sessionId: params.id,
          totalInput: session.totalInputTokens,
          totalOutput: session.totalOutputTokens,
          totalCacheRead: session.totalCacheReadTokens,
          totalCacheWrite: session.totalCacheWriteTokens,
          totalTokens: session.totalTokens,
          lastInputTokens: session.lastInputTokens,
        };
      } catch (error) {
        log.error("Failed to fetch session usage", { error, sessionId: params.id });
        return status(500, { error: "Failed to fetch session usage" });
      }
    })
    .delete(
      "/api/sessions/:id/messages",
      ({ params, query, status }) => {
        try {
          const sessionStore = getSessionStore();
          const notFound = requireSession(sessionStore, params.id, status);
          if (notFound) return notFound;

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
    );
}
