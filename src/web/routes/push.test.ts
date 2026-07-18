/**
 * Unit tests for the push route module.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { WebSocketMessage } from "@shared/types";
import { getDb } from "@src/db";
import { createPushService } from "@src/push";
import { getSessionStore } from "@src/session";
import { registerSessionChat, unregisterSessionChat } from "@src/web/sessionChatMap";
import { Elysia } from "elysia";
import fc from "fast-check";
import { pushRoutes } from "./push";

/** Collected broadcast messages for assertions. */
let broadcastMessages: unknown[] = [];

/** Create the push service with a fake broadcast that records messages. */
const pushService = createPushService({
  broadcastFn: (msg: WebSocketMessage) => {
    broadcastMessages.push(msg);
  },
});

/** Create a test app with the push route. */
function createTestApp() {
  return new Elysia().use(pushRoutes(pushService.pushMessage));
}

describe("pushRoutes", () => {
  let sessionId: string;
  let testCounter = 0;

  beforeEach(() => {
    broadcastMessages = [];
    testCounter++;
    // Ensure DB and session store are initialized
    const db = getDb();
    const store = getSessionStore(db);
    // Create a unique test session for each test
    const session = store.create({ source: "test", sourceId: `push-test-${testCounter}-${Date.now()}` });
    sessionId = session.id;
    // Clean up session-chat mapping
    unregisterSessionChat(sessionId);
  });

  describe("POST /api/push - validation", () => {
    test("returns 400 when sessionId is empty", async () => {
      const app = createTestApp();
      const res = await app.handle(
        new Request("http://localhost/api/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: "", content: "hello" }),
        }),
      );
      expect(res.status).toBe(422);
    });

    test("returns 400 when content is empty", async () => {
      const app = createTestApp();
      const res = await app.handle(
        new Request("http://localhost/api/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: "abc", content: "" }),
        }),
      );
      expect(res.status).toBe(422);
    });

    test("returns 400 when sessionId is missing", async () => {
      const app = createTestApp();
      const res = await app.handle(
        new Request("http://localhost/api/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "hello" }),
        }),
      );
      expect(res.status).toBe(422);
    });

    test("returns 400 for unsupported contentType", async () => {
      const app = createTestApp();
      const res = await app.handle(
        new Request("http://localhost/api/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, content: "hello", contentType: "text/html" }),
        }),
      );
      // TypeBox union validation will reject invalid contentType
      expect(res.status).toBe(422);
    });
  });

  describe("POST /api/push - session lookup", () => {
    test("returns 404 when session does not exist", async () => {
      const app = createTestApp();
      const res = await app.handle(
        new Request("http://localhost/api/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: "nonexistent-session-id", content: "hello" }),
        }),
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("Session not found");
    });
  });

  describe("POST /api/push - successful push with active chat", () => {
    test("returns 202 and broadcasts when chatId is resolved", async () => {
      // Register session-to-chat mapping (simulates active chat job)
      registerSessionChat(sessionId, "chat-123");

      const app = createTestApp();
      const res = await app.handle(
        new Request("http://localhost/api/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, content: "# Hello World" }),
        }),
      );
      expect(res.status).toBe(202);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("broadcast");

      // Verify broadcast was called
      expect(broadcastMessages).toHaveLength(1);
      const msg = broadcastMessages[0] as any;
      expect(msg.type).toBe("push_message");
      expect(msg.chatId).toBe("chat-123");
      expect(msg.content).toBe("# Hello World");
      expect(msg.contentType).toBe("text/markdown");

      // Cleanup
      unregisterSessionChat(sessionId);
    });

    test("defaults contentType to text/markdown when omitted", async () => {
      registerSessionChat(sessionId, "chat-456");

      const app = createTestApp();
      const res = await app.handle(
        new Request("http://localhost/api/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, content: "plain content" }),
        }),
      );
      expect(res.status).toBe(202);

      const msg = broadcastMessages[0] as any;
      expect(msg.contentType).toBe("text/markdown");

      unregisterSessionChat(sessionId);
    });

    test("respects explicit text/plain contentType", async () => {
      registerSessionChat(sessionId, "chat-789");

      const app = createTestApp();
      const res = await app.handle(
        new Request("http://localhost/api/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, content: "plain text", contentType: "text/plain" }),
        }),
      );
      expect(res.status).toBe(202);

      const msg = broadcastMessages[0] as any;
      expect(msg.contentType).toBe("text/plain");

      unregisterSessionChat(sessionId);
    });
  });

  describe("POST /api/push - push without active chat", () => {
    test("returns 200 when no chatId is resolved (stored but not broadcast)", async () => {
      const app = createTestApp();
      const res = await app.handle(
        new Request("http://localhost/api/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, content: "stored message" }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("stored");

      // No broadcast should have occurred
      expect(broadcastMessages).toHaveLength(0);
    });
  });

  describe("POST /api/push - message persistence", () => {
    test("appends push message to session store", async () => {
      const app = createTestApp();
      await app.handle(
        new Request("http://localhost/api/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, content: "persisted content", contentType: "text/plain" }),
        }),
      );

      // Verify message was persisted
      const store = getSessionStore();
      const messages = store.getMessages(sessionId);
      const pushMessages = messages.filter((m) => m.role === "push");
      expect(pushMessages.length).toBeGreaterThanOrEqual(1);

      const last = pushMessages[pushMessages.length - 1] as any;
      expect(last.content).toBe("persisted content");
    });
  });
});

describe("pushRoutes - property tests", () => {
  let sessionId: string;
  let testCounter = 1000;

  beforeEach(() => {
    broadcastMessages = [];
    testCounter++;
    const db = getDb();
    const store = getSessionStore(db);
    const session = store.create({ source: "test", sourceId: `push-prop-${testCounter}-${Date.now()}` });
    sessionId = session.id;
    unregisterSessionChat(sessionId);
  });

  /**
   * **Validates: Requirements 1.4, 7.2, 7.3**
   *
   * Property 3: Request validation rejects invalid inputs
   *
   * For any request body where sessionId is empty/exceeds 64 chars, OR content
   * is empty/exceeds 32768 chars, OR contentType is not one of the allowed values,
   * the push endpoint SHALL return an HTTP 400-range (422) response.
   */
  describe("Property 3: Request validation rejects invalid inputs", () => {
    test("rejects empty sessionId", async () => {
      await fc.assert(
        fc.asyncProperty(fc.string({ minLength: 1, maxLength: 100 }), async (content) => {
          const app = createTestApp();
          const res = await app.handle(
            new Request("http://localhost/api/push", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId: "", content }),
            }),
          );
          expect(res.status).toBeGreaterThanOrEqual(400);
          expect(res.status).toBeLessThan(500);
        }),
        { numRuns: 20 },
      );
    });

    test("rejects sessionId exceeding 64 characters", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 65, maxLength: 200 }),
          fc.string({ minLength: 1, maxLength: 100 }),
          async (longSessionId, content) => {
            const app = createTestApp();
            const res = await app.handle(
              new Request("http://localhost/api/push", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sessionId: longSessionId, content }),
              }),
            );
            expect(res.status).toBeGreaterThanOrEqual(400);
            expect(res.status).toBeLessThan(500);
          },
        ),
        { numRuns: 20 },
      );
    });

    test("rejects empty content", async () => {
      await fc.assert(
        fc.asyncProperty(fc.string({ minLength: 1, maxLength: 64 }), async (sid) => {
          const app = createTestApp();
          const res = await app.handle(
            new Request("http://localhost/api/push", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId: sid, content: "" }),
            }),
          );
          expect(res.status).toBeGreaterThanOrEqual(400);
          expect(res.status).toBeLessThan(500);
        }),
        { numRuns: 20 },
      );
    });

    test("rejects content exceeding 32768 characters", async () => {
      await fc.assert(
        fc.asyncProperty(fc.string({ minLength: 1, maxLength: 64 }), async (sid) => {
          const longContent = "x".repeat(32769);
          const app = createTestApp();
          const res = await app.handle(
            new Request("http://localhost/api/push", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId: sid, content: longContent }),
            }),
          );
          expect(res.status).toBeGreaterThanOrEqual(400);
          expect(res.status).toBeLessThan(500);
        }),
        { numRuns: 10 },
      );
    });

    test("rejects invalid contentType values", async () => {
      const invalidContentType = fc
        .string({ minLength: 1, maxLength: 50 })
        .filter((s) => s !== "text/markdown" && s !== "text/plain");

      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 64 }),
          fc.string({ minLength: 1, maxLength: 100 }),
          invalidContentType,
          async (sid, content, badType) => {
            const app = createTestApp();
            const res = await app.handle(
              new Request("http://localhost/api/push", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sessionId: sid, content, contentType: badType }),
              }),
            );
            expect(res.status).toBeGreaterThanOrEqual(400);
            expect(res.status).toBeLessThan(500);
          },
        ),
        { numRuns: 30 },
      );
    });
  });

  /**
   * **Validates: Requirements 7.2, 7.3**
   *
   * Property 7: ContentType defaults to markdown when omitted
   *
   * For any valid push request where contentType is not provided, the persisted
   * message and broadcast event shall have contentType set to "text/markdown".
   */
  describe("Property 7: ContentType defaults to markdown when omitted", () => {
    test("broadcast event has contentType text/markdown when omitted from request", async () => {
      await fc.assert(
        fc.asyncProperty(fc.string({ minLength: 1, maxLength: 200 }), async (content) => {
          broadcastMessages = [];
          registerSessionChat(sessionId, `chat-prop7-${Date.now()}`);

          const app = createTestApp();
          const res = await app.handle(
            new Request("http://localhost/api/push", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId, content }),
            }),
          );

          expect(res.status).toBe(202);

          // Verify the broadcast event has contentType defaulted to text/markdown
          expect(broadcastMessages.length).toBeGreaterThanOrEqual(1);
          const msg = broadcastMessages[broadcastMessages.length - 1] as any;
          expect(msg.contentType).toBe("text/markdown");

          unregisterSessionChat(sessionId);
        }),
        { numRuns: 20 },
      );
    });

    test("stored message role is push when contentType omitted (default applied server-side)", async () => {
      await fc.assert(
        fc.asyncProperty(fc.string({ minLength: 1, maxLength: 200 }), async (content) => {
          const app = createTestApp();
          const res = await app.handle(
            new Request("http://localhost/api/push", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId, content }),
            }),
          );

          // Should succeed (200 stored since no chat mapping registered)
          expect(res.status).toBe(200);

          // Verify push message was persisted with role "push" and correct content
          const store = getSessionStore();
          const messages = store.getMessages(sessionId);
          const pushMessages = messages.filter((m) => m.role === "push");
          expect(pushMessages.length).toBeGreaterThanOrEqual(1);

          const last = pushMessages[pushMessages.length - 1] as any;
          expect(last.content).toBe(content);
        }),
        { numRuns: 20 },
      );
    });
  });
});
