import { describe, expect, test } from "bun:test";
import { chatSendSync, conflictCode, truncateQuery } from "./chatSessionSync";

const conversation = [
  { id: "u1", role: "user" },
  { id: "a1", role: "assistant" },
  { id: "u2", role: "user" },
  { id: "a2", role: "assistant" },
  { id: "u3", role: "user" },
];

describe("chatSendSync", () => {
  test("names the previous user message and the turn index", () => {
    expect(chatSendSync(conversation, { id: "u3", role: "user" })).toEqual({
      clientMessageId: "u3",
      expectedLastClientId: "u2",
      userTurnIndex: 2,
    });
  });

  test("expects no predecessor for the first message", () => {
    expect(chatSendSync(conversation, { id: "u1", role: "user" })).toEqual({
      clientMessageId: "u1",
      expectedLastClientId: null,
      userTurnIndex: 0,
    });
  });

  test("throws for a message outside the conversation", () => {
    expect(() => chatSendSync(conversation, { id: "x", role: "user" })).toThrow();
  });
});

describe("truncateQuery", () => {
  test("a user message is deleted with everything after it", () => {
    expect(truncateQuery(conversation, { id: "u2", role: "user" })).toEqual({ from: "u2", keep: "1" });
  });

  test("an assistant message keeps the user message it answers", () => {
    expect(truncateQuery(conversation, { id: "a2", role: "assistant" })).toEqual({
      after: "u2",
      keep: "1",
      includeTrailing: "true",
    });
    expect(truncateQuery(conversation, { id: "a1", role: "assistant" })).toEqual({
      after: "u1",
      keep: "0",
      includeTrailing: "true",
    });
  });

  test("an assistant message without a user message before it clears the session", () => {
    expect(truncateQuery([{ id: "a0", role: "assistant" }], { id: "a0", role: "assistant" })).toEqual({ keep: "0" });
  });
});

describe("conflictCode", () => {
  test("reads known codes only", () => {
    expect(conflictCode({ code: "session_busy" })).toBe("session_busy");
    expect(conflictCode({ code: "session_diverged" })).toBe("session_diverged");
    expect(conflictCode({ code: "other" })).toBeUndefined();
    expect(conflictCode(null)).toBeUndefined();
  });
});
