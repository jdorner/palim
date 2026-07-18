/**
 * Chat route - accepts a user message and session ID, enqueues a chat job.
 *
 * The server resolves or creates sessions. The frontend sends a sessionId
 * (if it has one) plus the latest user message, not the full history.
 *
 * Handles `POST /api/chat`.
 */

import { Type } from "@sinclair/typebox";
import type { ChatJob } from "@src/jobs";
import type { ManagedQueuePort } from "@src/queue";
import { getSessionStore } from "@src/session";
import { isLLMConnectionError } from "@src/utils/error";
import { mainLogger as log } from "@src/utils/logger";
import { Elysia } from "elysia";

/**
 * Creates the chat route group.
 *
 * @param chatQueue - The managed chat queue to enqueue jobs into
 * @returns Elysia plugin with chat routes
 */
export function chatRoutes(chatQueue: ManagedQueuePort<ChatJob>) {
  return new Elysia().post(
    "/api/chat",
    async ({ body, status }) => {
      try {
        const sessionStore = getSessionStore();
        const { message, chatId, sessionId: requestedSessionId } = body;

        let sessionId: string;

        if (requestedSessionId) {
          const existing = sessionStore.get(requestedSessionId);
          if (!existing) {
            return status(404, { error: "Session not found" });
          }
          sessionId = existing.id;
        } else {
          const session = sessionStore.getOrCreate({ source: "chat", sourceId: chatId });
          sessionId = session.id;
        }

        // Append the user message to the session (skip when regenerating - message already exists)
        if (!body.skipAppend) {
          sessionStore.append(sessionId, {
            role: "user",
            content: message,
            timestamp: Date.now(),
          });
        }

        const jobData: ChatJob = {
          context: { source: "chat", id: chatId },
          sessionId,
        };

        const jobId = await chatQueue.add(`${chatId}`, jobData);

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
        skipAppend: Type.Optional(
          Type.Boolean({
            description:
              "Skip appending the message to the session (used for regeneration where the message already exists)",
          }),
        ),
      }),
    },
  );
}
