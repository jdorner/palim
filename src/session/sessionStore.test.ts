/**
 * Tests for {@link SessionStore}.
 *
 * Uses an in-memory SQLite database with Drizzle migrations applied
 * fresh for each test to ensure isolation.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import * as schema from "@src/db/schema";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { SessionStore } from "./sessionStore";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(__dirname, "../../drizzle");

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA journal_mode = WAL");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return db;
}

function makeTextMessage(role: string, text: string): AgentMessage {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function makeToolResultMessage(toolCallId: string, toolName: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

describe("SessionStore", () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(createTestDb());
  });

  // ---------------------------------------------------------------------------
  // Session CRUD
  // ---------------------------------------------------------------------------

  describe("session CRUD", () => {
    test("creates a session with generated id", () => {
      const session = store.create({ source: "chat" });
      expect(session.id).not.toBeNull();
      expect(session.source).toBe("chat");
      expect(session.sourceId).toBeNull();
      expect(session.createdAt).toBeGreaterThan(0);
    });

    test("creates a session with sourceId", () => {
      const session = store.create({ source: "telegram", sourceId: "chat-123" });
      expect(session.source).toBe("telegram");
      expect(session.sourceId).toBe("chat-123");
    });

    test("creates a session with metadata", () => {
      const session = store.create({ source: "chat", metadata: { foo: "bar" } });
      expect(session.metadata).toEqual({ foo: "bar" });
    });

    test("retrieves a session by id", () => {
      const created = store.create({ source: "chat", sourceId: "abc" });
      const retrieved = store.get(created.id);
      expect(retrieved).not.toBeUndefined();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.source).toBe("chat");
    });

    test("returns undefined for non-existent session", () => {
      expect(store.get("nonexistent")).toBeUndefined();
    });

    test("finds a session by source and sourceId", () => {
      store.create({ source: "telegram", sourceId: "chat-456" });
      const found = store.findBySource("telegram", "chat-456");
      expect(found).not.toBeUndefined();
      expect(found!.sourceId).toBe("chat-456");
    });

    test("returns undefined when findBySource has no match", () => {
      expect(store.findBySource("telegram", "nonexistent")).toBeUndefined();
    });

    test("getOrCreate returns existing session", () => {
      const created = store.create({ source: "chat", sourceId: "x1" });
      const found = store.getOrCreate({ source: "chat", sourceId: "x1" });
      expect(found.id).toBe(created.id);
    });

    test("getOrCreate creates new session when not found", () => {
      const session = store.getOrCreate({ source: "chat", sourceId: "new-one" });
      expect(session.id).not.toBeNull();
      expect(session.sourceId).toBe("new-one");
    });

    test("deletes a session and its messages", () => {
      const session = store.create({ source: "chat" });
      store.append(session.id, makeTextMessage("user", "hello"));
      store.delete(session.id);
      expect(store.get(session.id)).toBeUndefined();
      expect(store.getMessages(session.id)).toEqual([]);
    });

    test("lists sessions ordered by updatedAt descending", () => {
      const s1 = store.create({ source: "chat", sourceId: "a" });
      const s2 = store.create({ source: "chat", sourceId: "b" });
      // Append to s1 to make it more recently updated
      store.append(s1.id, makeTextMessage("user", "bump"));

      const list = store.list();
      expect(list.length).toBe(2);
      expect(list[0]!.id).toBe(s1.id);
      expect(list[1]!.id).toBe(s2.id);
    });

    test("lists sessions filtered by source", () => {
      store.create({ source: "chat", sourceId: "c1" });
      store.create({ source: "telegram", sourceId: "t1" });

      const chatSessions = store.list({ source: "chat" });
      expect(chatSessions.length).toBe(1);
      expect(chatSessions[0]!.source).toBe("chat");
    });

    test("lists sessions with limit", () => {
      store.create({ source: "chat", sourceId: "l1" });
      store.create({ source: "chat", sourceId: "l2" });
      store.create({ source: "chat", sourceId: "l3" });

      const limited = store.list({ limit: 2 });
      expect(limited.length).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Message operations
  // ---------------------------------------------------------------------------

  describe("message operations", () => {
    test("appends and retrieves text messages in order", () => {
      const session = store.create({ source: "chat" });
      store.append(session.id, makeTextMessage("user", "first"));
      store.append(session.id, makeTextMessage("assistant", "second"));

      const messages = store.getMessages(session.id);
      expect(messages.length).toBe(2);
      expect((messages[0]!.content as Array<{ text: string }>)[0]!.text).toBe("first");
      expect((messages[1]!.content as Array<{ text: string }>)[0]!.text).toBe("second");
    });

    test("retrieves messages with limit (most recent)", () => {
      const session = store.create({ source: "chat" });
      store.append(session.id, makeTextMessage("user", "msg1"));
      store.append(session.id, makeTextMessage("assistant", "msg2"));
      store.append(session.id, makeTextMessage("user", "msg3"));

      const messages = store.getMessages(session.id, { limit: 2 });
      expect(messages.length).toBe(2);
      // Should be the 2 most recent, in ascending order
      expect((messages[0]!.content as Array<{ text: string }>)[0]!.text).toBe("msg2");
      expect((messages[1]!.content as Array<{ text: string }>)[0]!.text).toBe("msg3");
    });

    test("replaceMessages atomically replaces all messages", () => {
      const session = store.create({ source: "chat" });
      store.append(session.id, makeTextMessage("user", "old"));

      store.replaceMessages(session.id, [makeTextMessage("user", "new1"), makeTextMessage("assistant", "new2")]);

      const messages = store.getMessages(session.id);
      expect(messages.length).toBe(2);
      expect((messages[0]!.content as Array<{ text: string }>)[0]!.text).toBe("new1");
      expect((messages[1]!.content as Array<{ text: string }>)[0]!.text).toBe("new2");
    });

    test("replaceMessages with empty array clears all messages", () => {
      const session = store.create({ source: "chat" });
      store.append(session.id, makeTextMessage("user", "will be gone"));

      store.replaceMessages(session.id, []);

      const messages = store.getMessages(session.id);
      expect(messages.length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // toolResult message persistence (the bug fix)
  // ---------------------------------------------------------------------------

  describe("toolResult message persistence", () => {
    test("preserves toolCallId on round-trip", () => {
      const session = store.create({ source: "chat" });
      const toolResult = makeToolResultMessage("call_abc123", "exec", "command output");

      store.append(session.id, toolResult);

      const messages = store.getMessages(session.id);
      expect(messages.length).toBe(1);

      const restored = messages[0] as unknown as { role: string; toolCallId: string; toolName: string };
      expect(restored.role).toBe("toolResult");
      expect(restored.toolCallId).toBe("call_abc123");
      expect(restored.toolName).toBe("exec");
    });

    test("preserves toolCallId for multiple parallel tool results", () => {
      const session = store.create({ source: "chat" });

      store.append(session.id, makeToolResultMessage("id_AAA", "exec", "result 1"));
      store.append(session.id, makeToolResultMessage("id_BBB", "exec", "result 2"));

      const messages = store.getMessages(session.id);
      expect(messages.length).toBe(2);

      const r1 = messages[0] as unknown as { toolCallId: string; toolName: string };
      const r2 = messages[1] as unknown as { toolCallId: string; toolName: string };
      expect(r1.toolCallId).toBe("id_AAA");
      expect(r2.toolCallId).toBe("id_BBB");
    });

    test("preserves toolCallId through replaceMessages", () => {
      const session = store.create({ source: "chat" });

      store.replaceMessages(session.id, [
        makeTextMessage("user", "do something"),
        makeToolResultMessage("call_xyz", "read_file", "file contents"),
      ]);

      const messages = store.getMessages(session.id);
      expect(messages.length).toBe(2);

      const toolMsg = messages[1] as unknown as { role: string; toolCallId: string; toolName: string };
      expect(toolMsg.role).toBe("toolResult");
      expect(toolMsg.toolCallId).toBe("call_xyz");
      expect(toolMsg.toolName).toBe("read_file");
    });

    test("preserves tool result content alongside toolCallId", () => {
      const session = store.create({ source: "chat" });
      const toolResult = makeToolResultMessage("call_99", "list_files", "file1.ts\nfile2.ts");

      store.append(session.id, toolResult);

      const messages = store.getMessages(session.id);
      const restored = messages[0] as unknown as { content: Array<{ type: string; text: string }> };
      expect(restored.content[0]!.text).toBe("file1.ts\nfile2.ts");
    });

    test("non-toolResult messages do not get toolCallId", () => {
      const session = store.create({ source: "chat" });
      store.append(session.id, makeTextMessage("user", "hello"));
      store.append(session.id, makeTextMessage("assistant", "hi"));

      const messages = store.getMessages(session.id);
      for (const msg of messages) {
        const m = msg as unknown as { toolCallId?: string };
        expect(m.toolCallId).toBeUndefined();
      }
    });

    test("interleaved assistant and toolResult messages preserve correct ids", () => {
      const session = store.create({ source: "chat" });

      store.append(session.id, makeTextMessage("user", "run two commands"));
      store.append(session.id, makeTextMessage("assistant", "running..."));
      store.append(session.id, makeToolResultMessage("call_1", "exec", "output 1"));
      store.append(session.id, makeToolResultMessage("call_2", "exec", "output 2"));
      store.append(session.id, makeTextMessage("assistant", "done"));

      const messages = store.getMessages(session.id);
      expect(messages.length).toBe(5);

      const tr1 = messages[2] as unknown as { toolCallId: string };
      const tr2 = messages[3] as unknown as { toolCallId: string };
      expect(tr1.toolCallId).toBe("call_1");
      expect(tr2.toolCallId).toBe("call_2");

      // Assistant messages should not have toolCallId
      const assistant = messages[4] as unknown as { toolCallId?: string };
      expect(assistant.toolCallId).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Session handle bound methods
  // ---------------------------------------------------------------------------

  describe("session handle methods", () => {
    test("session.append works via bound method", () => {
      const session = store.create({ source: "chat" });
      session.append(makeTextMessage("user", "via handle"));

      const messages = session.getMessages();
      expect(messages.length).toBe(1);
      expect((messages[0]!.content as Array<{ text: string }>)[0]!.text).toBe("via handle");
    });

    test("session.replaceMessages works via bound method", () => {
      const session = store.create({ source: "chat" });
      session.append(makeTextMessage("user", "old"));
      session.replaceMessages([makeTextMessage("user", "replaced")]);

      const messages = session.getMessages();
      expect(messages.length).toBe(1);
      expect((messages[0]!.content as Array<{ text: string }>)[0]!.text).toBe("replaced");
    });

    test("session.delete works via bound method", () => {
      const session = store.create({ source: "chat", sourceId: "del-test" });
      session.delete();
      expect(store.get(session.id)).toBeUndefined();
    });
  });
});
