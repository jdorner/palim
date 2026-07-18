/**
 * Push route - thin HTTP wrapper over the push service.
 * Accepts out-of-band messages from sandbox scripts and delegates to
 * the programmatic push API.
 *
 * Handles `POST /api/push`.
 */

import { Type } from "@sinclair/typebox";
import type { PushMessageFn } from "@src/push";
import { Elysia } from "elysia";

/**
 * Creates the push route group.
 *
 * @param pushMessage - The programmatic push function from the push service
 * @returns Elysia plugin with push routes
 */
export function pushRoutes(pushMessage: PushMessageFn) {
  return new Elysia().post(
    "/api/push",
    async ({ body, status }) => {
      const { sessionId, content, contentType: rawContentType } = body;
      const contentType = rawContentType ?? "text/markdown";

      try {
        const result = pushMessage(sessionId, content, { contentType });
        return status(result.status === "broadcast" ? 202 : 200, { status: result.status });
      } catch (err) {
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
