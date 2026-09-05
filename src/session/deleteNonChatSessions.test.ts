/**
 * Tests for {@link deleteNonChatSessions}.
 *
 * Verifies the session-cleanup rule applied when jobs are removed from the
 * queue: non-chat sessions (and their messages) are deleted, chat conversations
 * are preserved, and unknown IDs are ignored.
 *
 * Uses an in-memory SQLite database with Drizzle migrations applied fresh for
 * each test to ensure isolation.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createTestDb } from "@src/test/db";
import { deleteNonChatSessions } from "./index";
import { SessionStore } from "./sessionStore";

function makeTextMessage(role: string, text: string): AgentMessage {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

describe("deleteNonChatSessions", () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(createTestDb());
  });

  test("deletes a non-chat session and its messages", () => {
    const session = store.create({ source: "scheduler" });
    store.append(session.id, makeTextMessage("user", "run the job"));

    const deleted = deleteNonChatSessions(store, [session.id]);

    expect(deleted).toEqual([session.id]);
    expect(store.get(session.id)).toBeUndefined();
    expect(store.getMessages(session.id)).toEqual([]);
  });

  test("preserves chat sessions", () => {
    const session = store.create({ source: "chat" });
    store.append(session.id, makeTextMessage("user", "hello"));

    const deleted = deleteNonChatSessions(store, [session.id]);

    expect(deleted).toEqual([]);
    expect(store.get(session.id)).not.toBeUndefined();
    expect(store.getMessages(session.id)).not.toEqual([]);
  });

  test("deletes non-chat sessions regardless of source (telegram, workflow, etc.)", () => {
    const telegram = store.create({ source: "telegram", sourceId: "chat-1" });
    const workflow = store.create({ source: "workflow", sourceId: "run-1" });

    const deleted = deleteNonChatSessions(store, [telegram.id, workflow.id]);

    expect(deleted).toContain(telegram.id);
    expect(deleted).toContain(workflow.id);
    expect(store.get(telegram.id)).toBeUndefined();
    expect(store.get(workflow.id)).toBeUndefined();
  });

  test("only removes non-chat sessions from a mixed set", () => {
    const chat = store.create({ source: "chat" });
    const scheduler = store.create({ source: "scheduler" });

    const deleted = deleteNonChatSessions(store, [chat.id, scheduler.id]);

    expect(deleted).toEqual([scheduler.id]);
    expect(store.get(chat.id)).not.toBeUndefined();
    expect(store.get(scheduler.id)).toBeUndefined();
  });

  test("ignores unknown session IDs", () => {
    const deleted = deleteNonChatSessions(store, ["does-not-exist"]);
    expect(deleted).toEqual([]);
  });

  test("returns an empty array for an empty input", () => {
    const deleted = deleteNonChatSessions(store, []);
    expect(deleted).toEqual([]);
  });
});
