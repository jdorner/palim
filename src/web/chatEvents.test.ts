/**
 * Unit tests for agent event to chat WebSocket event mapping.
 */

import { describe, expect, test } from "bun:test";
import type { EventParam } from "@src/extensions";
import { mapAgentEventToChatEvent } from "./chatEvents";

/** Helper to create a minimal EventParam with chat context. */
function chatEvent(type: string, extra: Record<string, unknown> = {}): EventParam {
  return {
    type,
    context: { source: "chat", id: "chat-123", jobId: "job-456" },
    ...extra,
  } as unknown as EventParam;
}

describe("mapAgentEventToChatEvent", () => {
  describe("filtering", () => {
    test("returns undefined for events without context", () => {
      const event = { type: "agent_end", messages: [] } as unknown as EventParam;
      expect(mapAgentEventToChatEvent(event)).toBeUndefined();
    });

    test("returns undefined for non-chat source events", () => {
      const event = {
        type: "agent_end",
        messages: [],
        context: { source: "telegram", id: "123" },
      } as unknown as EventParam;
      expect(mapAgentEventToChatEvent(event)).toBeUndefined();
    });

    test("returns undefined for unknown event types", () => {
      const event = chatEvent("turn_start");
      expect(mapAgentEventToChatEvent(event)).toBeUndefined();
    });
  });

  describe("message_update", () => {
    test("maps text_delta to chat text_delta event", () => {
      const event = chatEvent("message_update", {
        assistantMessageEvent: { type: "text_delta", delta: "Hello" },
      });
      const result = mapAgentEventToChatEvent(event);
      expect(result).toEqual({
        type: "chat_event",
        chatId: "chat-123",
        event: "text_delta",
        content: "Hello",
      });
    });

    test("maps thinking_delta to chat thinking_delta event", () => {
      const event = chatEvent("message_update", {
        assistantMessageEvent: { type: "thinking_delta", delta: "Hmm..." },
      });
      const result = mapAgentEventToChatEvent(event);
      expect(result).toEqual({
        type: "chat_event",
        chatId: "chat-123",
        event: "thinking_delta",
        content: "Hmm...",
      });
    });

    test("returns undefined for non-text assistant events", () => {
      const event = chatEvent("message_update", {
        assistantMessageEvent: { type: "toolcall_start" },
      });
      expect(mapAgentEventToChatEvent(event)).toBeUndefined();
    });
  });

  describe("tool_execution_start", () => {
    test("maps to tool_start event with name and args", () => {
      const event = chatEvent("tool_execution_start", {
        toolName: "read_file",
        args: { path: "/foo.txt" },
      });
      const result = mapAgentEventToChatEvent(event);
      expect(result).toEqual({
        type: "chat_event",
        chatId: "chat-123",
        event: "tool_start",
        toolName: "read_file",
        toolArgs: { path: "/foo.txt" },
      });
    });
  });

  describe("tool_execution_end", () => {
    test("maps to tool_end event with result text", () => {
      const event = chatEvent("tool_execution_end", {
        toolName: "read_file",
        result: { content: [{ type: "text", text: "file contents here" }] },
      });
      const result = mapAgentEventToChatEvent(event);
      expect(result).toEqual({
        type: "chat_event",
        chatId: "chat-123",
        event: "tool_end",
        toolName: "read_file",
        toolResult: "file contents here",
      });
    });

    test("returns undefined toolResult when result has no text content", () => {
      const event = chatEvent("tool_execution_end", {
        toolName: "exec",
        result: { content: [{ type: "image", data: "..." }] },
      });
      const result = mapAgentEventToChatEvent(event);
      expect(result?.event).toBe("tool_end");
      expect(result?.toolResult).toBeUndefined();
    });
  });

  describe("agent_end", () => {
    test("maps to done event with final assistant text and usage", () => {
      const event = chatEvent("agent_end", {
        messages: [
          { role: "user", content: "Hi" },
          {
            role: "assistant",
            content: [{ type: "text", text: "Hello there!" }],
            usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 15 },
          },
        ],
      });
      const result = mapAgentEventToChatEvent(event);
      expect(result).toEqual({
        type: "chat_event",
        chatId: "chat-123",
        event: "done",
        content: "Hello there!",
        jobId: "job-456",
        usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 15 },
      });
    });

    test("returns done with empty content when no assistant messages", () => {
      const event = chatEvent("agent_end", {
        messages: [{ role: "user", content: "Hi" }],
      });
      const result = mapAgentEventToChatEvent(event);
      expect(result?.event).toBe("done");
      expect(result?.content).toBe("");
      expect(result?.usage).toBeUndefined();
    });

    test("picks the last assistant message text", () => {
      const event = chatEvent("agent_end", {
        messages: [
          { role: "assistant", content: [{ type: "text", text: "First reply" }], usage: { input: 5 } },
          { role: "user", content: "More?" },
          { role: "assistant", content: [{ type: "text", text: "Second reply" }], usage: { input: 20 } },
        ],
      });
      const result = mapAgentEventToChatEvent(event);
      expect(result?.content).toBe("Second reply");
      expect(result?.usage?.input).toBe(20);
    });

    test("defaults missing usage fields to 0", () => {
      const event = chatEvent("agent_end", {
        messages: [{ role: "assistant", content: [{ type: "text", text: "Hi" }], usage: { input: 7 } }],
      });
      const result = mapAgentEventToChatEvent(event);
      expect(result?.usage).toEqual({
        input: 7,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
      });
    });

    test("handles empty messages array", () => {
      const event = chatEvent("agent_end", { messages: [] });
      const result = mapAgentEventToChatEvent(event);
      expect(result?.event).toBe("done");
      expect(result?.content).toBe("");
    });
  });

  describe("message_end", () => {
    test("returns undefined (done is sent from agent_end instead)", () => {
      const event = chatEvent("message_end", {
        message: { role: "assistant", content: [{ type: "text", text: "Hi" }] },
      });
      expect(mapAgentEventToChatEvent(event)).toBeUndefined();
    });
  });
});
