/**
 * Session routes - provides REST endpoints for session inspection.
 *
 * Handles:
 * - `GET    /api/sessions` (the caller's own sessions of one source, for importing chats)
 * - `GET    /api/sessions/:id` (summary: title and last user message ID)
 * - `PATCH  /api/sessions/:id` (rename)
 * - `GET    /api/sessions/:id/chat` (the session converted into chat UI messages)
 * - `GET    /api/sessions/:id/messages`
 * - `DELETE /api/sessions/:id/messages`
 * - `DELETE /api/sessions/:id`
 *
 * Note: Skill request routes are defined in `src/jobs/skillRequestQueue.ts`.
 */

import { sessionTitle, sessionToChatMessages, userMessageId } from "@shared/chatTranscript";
import { Type } from "@sinclair/typebox";
import { ownedSubject } from "@src/auth";
import { getSessionStore } from "@src/session";
import { cutSeqForClientId } from "@src/session/chatSync";
import type { NotifySessionChanged } from "@src/session/sessionEvents";
import type { SessionSummary } from "@src/session/types";
import { mainLogger as log } from "@src/utils/logger";
import { Elysia } from "elysia";
import { getPrincipal } from "../auth";
import type { ChatSessionGuard } from "../chatSessionGuard";

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
 * Describes a session for the chat UI: its derived title and the client ID of
 * its last user message, which the UI compares with its own copy.
 *
 * @param summary - The session summary from the store
 * @returns The response body
 */
function describeSession(summary: SessionSummary) {
  return {
    id: summary.id,
    // The ID every client gives the conversation mirroring this session.
    conversationId: summary.sourceId ?? summary.id,
    title: sessionTitle(summary.title, summary.firstUserContent),
    // Whether the user gave the title (else it is derived from the first user message).
    titleSet: summary.title !== null,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    // The ID the converted transcript gives that message, so the UI compares like with like.
    lastUserClientId: summary.lastUserSeq > 0 ? userMessageId(summary.lastUserClientId, summary.lastUserSeq) : null,
  };
}

/**
 * Creates the session route group.
 *
 * @param sessionGuard - Claims a session while a request changes it (shared with the chat route)
 * @param notifySessionChanged - Announces truncations to the owner's other tabs and devices
 * @returns Elysia plugin with session routes
 */
export function sessionRoutes(sessionGuard: ChatSessionGuard, notifySessionChanged?: NotifySessionChanged) {
  return new Elysia()
    .get(
      "/api/sessions",
      ({ query, request, status }) => {
        const principal = getPrincipal(request);
        if (!principal) return status(401, { error: "Unauthorized" });
        try {
          const sessions = getSessionStore().listSessionSummaries(principal.user.id, query.source).map(describeSession);
          return { sessions };
        } catch (error) {
          log.error("Failed to list sessions", { error });
          return status(500, { error: "Failed to list sessions" });
        }
      },
      {
        query: Type.Object({
          source: Type.String({ minLength: 1, description: "Session source to list (e.g. 'chat')" }),
        }),
      },
    )
    .get("/api/sessions/:id", ({ params, request, status }) => {
      try {
        const sessionStore = getSessionStore();
        const denied = requireOwnedSession(sessionStore, params.id, request, "read", status);
        if (denied) return denied;
        return describeSession(sessionStore.getSessionSummary(params.id));
      } catch (error) {
        log.error("Failed to read session", { error, sessionId: params.id });
        return status(500, { error: "Failed to read session" });
      }
    })
    .get("/api/sessions/:id/chat", ({ params, request, status }) => {
      try {
        const sessionStore = getSessionStore();
        const denied = requireOwnedSession(sessionStore, params.id, request, "read", status);
        if (denied) return denied;
        return {
          ...describeSession(sessionStore.getSessionSummary(params.id)),
          messages: sessionToChatMessages(params.id, sessionStore.getTranscriptRows(params.id)),
        };
      } catch (error) {
        log.error("Failed to convert session", { error, sessionId: params.id });
        return status(500, { error: "Failed to read session" });
      }
    })
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
      async ({ params, query, request, status }) => {
        try {
          const sessionStore = getSessionStore();
          const denied = requireOwnedSession(sessionStore, params.id, request, "update", status);
          if (denied) return denied;

          if (!(await sessionGuard.claim(params.id))) {
            return status(409, { error: "A response is still being generated for this session", code: "session_busy" });
          }
          try {
            const target = query.from
              ? { clientId: query.from, mode: "from" as const }
              : query.after
                ? { clientId: query.after, mode: "after" as const }
                : undefined;
            // Without a target, everything goes.
            const cutSeq = target
              ? cutSeqForClientId(sessionStore.getUserMessageMarkers(params.id), target.clientId, target.mode)
              : 0;
            if (cutSeq === undefined) {
              return status(409, { error: "The conversation does not match the session", code: "session_diverged" });
            }

            if (sessionStore.truncateFrom(params.id, cutSeq) > 0) {
              notifySessionChanged?.(params.id, "truncate", query.origin);
            }
            return status(200, { sessionId: params.id, ok: true });
          } finally {
            sessionGuard.release(params.id);
          }
        } catch (error) {
          log.error("Failed to truncate session messages", { error, sessionId: params.id });
          return status(500, { error: "Failed to truncate session messages" });
        }
      },
      {
        query: Type.Object({
          from: Type.Optional(
            Type.String({
              minLength: 1,
              description: "Client ID of a user message: delete it and everything after it",
            }),
          ),
          after: Type.Optional(
            Type.String({
              minLength: 1,
              description: "Client ID of a user message: keep it, delete everything after it",
            }),
          ),
          origin: Type.Optional(
            Type.String({
              minLength: 1,
              description: "Client-chosen request ID, echoed in the session_changed event so the caller can skip it",
            }),
          ),
        }),
      },
    )
    .patch(
      "/api/sessions/:id",
      ({ params, body, request, status }) => {
        try {
          const sessionStore = getSessionStore();
          const denied = requireOwnedSession(sessionStore, params.id, request, "update", status);
          if (denied) return denied;
          const title = body.title?.trim() || null;
          sessionStore.setTitle(params.id, title);
          notifySessionChanged?.(params.id, "rename");
          return describeSession(sessionStore.getSessionSummary(params.id));
        } catch (error) {
          log.error("Failed to rename session", { error, sessionId: params.id });
          return status(500, { error: "Failed to rename session" });
        }
      },
      {
        body: Type.Object({
          title: Type.Union([Type.String({ maxLength: 200 }), Type.Null()], {
            description: "The new title; null or blank derives it from the first user message again",
          }),
        }),
      },
    )
    .delete("/api/sessions/:id", ({ params, request, status }) => {
      try {
        const sessionStore = getSessionStore();
        const denied = requireOwnedSession(sessionStore, params.id, request, "delete", status);
        if (denied) return denied;

        notifySessionChanged?.(params.id, "deleted");
        sessionStore.delete(params.id);

        return status(200, { sessionId: params.id, ok: true });
      } catch (error) {
        log.error("Failed to delete session", { error, sessionId: params.id });
        return status(500, { error: "Failed to delete session" });
      }
    });
}
