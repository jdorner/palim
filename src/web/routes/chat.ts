/**
 * Chat route - accepts a user message and session ID, enqueues a chat job.
 *
 * The server resolves or creates sessions. The frontend sends a sessionId
 * (if it has one) plus the latest user message, not the full history.
 *
 * With a `clientMessageId` the message is matched against the session by that
 * ID (see `src/session/chatSync.ts`): resending the session's last user
 * message reruns it, and a UI that disagrees with the session gets a 409.
 *
 * Handles `POST /api/chat`.
 */

import { Type } from "@sinclair/typebox";
import { ownedSubject } from "@src/auth";
import type { ChatJob } from "@src/jobs";
import type { ManagedQueuePort } from "@src/queue";
import { getSessionStore } from "@src/session";
import { planChatSend } from "@src/session/chatSync";
import type { NotifySessionChanged } from "@src/session/sessionEvents";
import { isLLMConnectionError } from "@src/utils/error";
import { mainLogger as log } from "@src/utils/logger";
import { Elysia } from "elysia";
import { getPrincipal } from "../auth";
import type { ChatSessionGuard } from "../chatSessionGuard";

/**
 * Creates the chat route group.
 *
 * @param chatQueue - The managed chat queue to enqueue jobs into
 * @param sessionGuard - Claims a session while a request changes it (shared with the session routes)
 * @param registerChatOwner - Records the chat's owner before enqueueing so streamed
 *   output is scoped to them from the first event
 * @param notifySessionChanged - Announces the new message to the owner's other tabs and devices
 * @returns Elysia plugin with chat routes
 */
export function chatRoutes(
  chatQueue: ManagedQueuePort<ChatJob>,
  sessionGuard: ChatSessionGuard,
  registerChatOwner?: (chatId: string, userId: string | null) => void,
  notifySessionChanged?: NotifySessionChanged,
) {
  return new Elysia().post(
    "/api/chat",
    async ({ body, request, status }) => {
      try {
        const sessionStore = getSessionStore();
        const { message, chatId, sessionId: requestedSessionId, conversationId } = body;

        const principal = getPrincipal(request);
        const initiatorUserId = principal?.user.id;

        // Resolve the target session: by explicit ID, or by the client's
        // conversation ID (falling back to the chat ID), which may match an
        // existing session, possibly owned by someone else.
        const session = requestedSessionId
          ? sessionStore.get(requestedSessionId)
          : sessionStore.getOrCreate({
              source: "chat",
              sourceId: conversationId ?? chatId,
              ...(initiatorUserId ? { userId: initiatorUserId } : {}),
            });
        if (!session) {
          return status(404, { error: "Session not found" });
        }
        // Enforce ownership on both paths: a caller may only post into a session
        // they own (admins may post into any). Respond 404 to avoid leaking existence.
        const owns = principal?.ability.can("update", ownedSubject("Session", { userId: session.userId }));
        if (!owns) {
          return status(404, { error: "Session not found" });
        }
        const sessionId = session.id;

        if (!(await sessionGuard.claim(sessionId))) {
          return status(409, { error: "A response is still being generated for this session", code: "session_busy" });
        }
        let jobId: string;
        try {
          const { clientMessageId } = body;
          const plan = clientMessageId
            ? planChatSend(
                sessionStore.getUserMessageMarkers(sessionId),
                clientMessageId,
                body.expectedLastClientId ?? null,
              )
            : ({ kind: "append" } as const);
          if (plan.kind === "diverged") {
            return status(409, { error: "The conversation does not match the session", code: "session_diverged" });
          }
          if (plan.kind === "rerun") {
            // The message already arrived (retry or regenerate): drop whatever followed it.
            sessionStore.truncateFrom(sessionId, plan.cutSeq);
          } else {
            sessionStore.append(
              sessionId,
              { role: "user", content: message, timestamp: Date.now() },
              clientMessageId ? { clientId: clientMessageId } : undefined,
            );
          }

          const jobData: ChatJob = {
            context: { source: "chat", id: chatId },
            sessionId,
            ...(initiatorUserId ? { initiatorUserId } : {}),
          };

          registerChatOwner?.(chatId, initiatorUserId ?? null);
          jobId = await chatQueue.add(`${chatId}`, jobData);
        } finally {
          // Once enqueued, the pending job itself keeps the session busy.
          sessionGuard.release(sessionId);
        }

        notifySessionChanged?.(sessionId, "message", chatId);
        log.info("Chat job enqueued", { jobId, chatId, sessionId });
        return status(201, { jobId, sessionId });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        if (isLLMConnectionError(errMsg)) {
          log.error(`LLM connection failure during chat: ${errMsg}`);
          return status(502, { error: "LLM service unavailable" });
        }
        log.error(`Failed to enqueue chat job: ${errMsg}`);
        return status(500, { error: "Failed to enqueue chat job" });
      }
    },
    {
      body: Type.Object({
        message: Type.String({ minLength: 1, description: "The user message to send" }),
        chatId: Type.String({ minLength: 1, description: "Client-generated conversation correlation ID" }),
        sessionId: Type.Optional(Type.String({ description: "Existing session ID" })),
        conversationId: Type.Optional(
          Type.String({
            minLength: 1,
            description:
              "Client-generated conversation ID; without sessionId it names the session (its sourceId), so every client mirrors the session under the same ID",
          }),
        ),
        clientMessageId: Type.Optional(
          Type.String({
            minLength: 1,
            description:
              "Client-generated ID of this user message. Resending the session's last user message reruns it instead of appending",
          }),
        ),
        expectedLastClientId: Type.Optional(
          Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
            description:
              "Client ID of the user message the client sees before this one (null: none). A mismatch with the session returns 409",
          }),
        ),
      }),
    },
  );
}
