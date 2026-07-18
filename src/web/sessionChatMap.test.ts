import { beforeEach, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { registerSessionChat, resolveSessionChat, unregisterSessionChat } from "./sessionChatMap";

describe("sessionChatMap", () => {
  // Reset state between tests by unregistering known keys
  beforeEach(() => {
    unregisterSessionChat("session-1");
    unregisterSessionChat("session-2");
    unregisterSessionChat("session-3");
  });

  describe("registerSessionChat", () => {
    test("stores a session-to-chat mapping", () => {
      registerSessionChat("session-1", "chat-abc");
      expect(resolveSessionChat("session-1")).toBe("chat-abc");
    });

    test("overwrites an existing mapping for the same session", () => {
      registerSessionChat("session-1", "chat-old");
      registerSessionChat("session-1", "chat-new");
      expect(resolveSessionChat("session-1")).toBe("chat-new");
    });
  });

  describe("unregisterSessionChat", () => {
    test("removes the mapping for a session", () => {
      registerSessionChat("session-1", "chat-abc");
      unregisterSessionChat("session-1");
      expect(resolveSessionChat("session-1")).toBeUndefined();
    });

    test("does not throw when unregistering a non-existent session", () => {
      expect(() => unregisterSessionChat("non-existent")).not.toThrow();
    });
  });

  describe("resolveSessionChat", () => {
    test("returns undefined for an unknown session", () => {
      expect(resolveSessionChat("unknown")).toBeUndefined();
    });

    test("returns the correct chatId when multiple sessions are registered", () => {
      registerSessionChat("session-1", "chat-1");
      registerSessionChat("session-2", "chat-2");
      registerSessionChat("session-3", "chat-3");
      expect(resolveSessionChat("session-2")).toBe("chat-2");
    });
  });
});

describe("sessionChatMap - property tests", () => {
  const sessionIdArb = fc.string({ minLength: 1, maxLength: 64 });
  const chatIdArb = fc.string({ minLength: 1, maxLength: 64 });

  /**
   * **Validates: Requirements 5.2, 5.3**
   *
   * Property 4: Session-to-chat map consistency with job lifecycle
   *
   * For any sequence of (register then unregister), after register the mapping
   * exists with the correct chatId, and after unregister it does not exist.
   */
  test("Property 4: register then unregister yields consistent state", () => {
    fc.assert(
      fc.property(sessionIdArb, chatIdArb, (sessionId, chatId) => {
        // Simulate job becoming active
        registerSessionChat(sessionId, chatId);
        expect(resolveSessionChat(sessionId)).toBe(chatId);

        // Simulate job completing/failing
        unregisterSessionChat(sessionId);
        expect(resolveSessionChat(sessionId)).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 5.5**
   *
   * Property 5: Session-to-chat map overwrite on new job
   *
   * For any sessionId already mapped, when a new chatId is registered for the
   * same session, the map contains only the new chatId.
   */
  test("Property 5: registering a new chatId for the same session overwrites the previous", () => {
    fc.assert(
      fc.property(sessionIdArb, chatIdArb, chatIdArb, (sessionId, oldChatId, newChatId) => {
        // First job registers
        registerSessionChat(sessionId, oldChatId);
        expect(resolveSessionChat(sessionId)).toBe(oldChatId);

        // New job overwrites
        registerSessionChat(sessionId, newChatId);
        expect(resolveSessionChat(sessionId)).toBe(newChatId);

        // Cleanup
        unregisterSessionChat(sessionId);
      }),
      { numRuns: 100 },
    );
  });
});
