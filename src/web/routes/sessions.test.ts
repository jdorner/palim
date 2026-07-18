/**
 * Tests for the session routes DELETE endpoint turn-based truncation logic.
 *
 * Exercises the Elysia route handler via `.handle()` using a fresh
 * in-memory SQLite database for each test.
 *
 * Because `getSessionStore()` is a module-level singleton that only
 * initializes once, we call it once with the first DB and then use
 * unique sourceIds per test to avoid conflicts.
 */

import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import * as schema from "@src/db/schema";
import { getSessionStore, type SessionStore } from "@src/session";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { sessionRoutes } from "./sessions";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(__dirname, "../../../drizzle");

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA journal_mode = WAL");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return db;
}

function userMsg(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as unknown as AgentMessage;
}

function assistantMsg(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() } as unknown as AgentMessage;
}

function toolResultMsg(toolCallId: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "exec",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

/**
 * Extracts the text content from an AgentMessage for assertions.
 */
function textOf(msg: AgentMessage): string {
  const content = msg.content as Array<{ type: string; text: string }>;
  return content[0]?.text ?? "";
}

describe("DELETE /api/sessions/:id/messages (turn-based truncation)", () => {
  let store: SessionStore;
  let app: ReturnType<typeof sessionRoutes>;

  beforeAll(() => {
    // Initialize the singleton once - all tests share this DB instance
    const db = createTestDb();
    store = getSessionStore(db);
    app = sessionRoutes();
  });

  /**
   * Creates a test session with a realistic multi-turn conversation:
   * Turn 1: user₁ → assistant₁ (with tool call round)
   * Turn 2: user₂ → assistant₂
   * Turn 3: user₃ → assistant₃ (with tool call round)
   */
  function createTestSession(): string {
    const session = store.create({ source: "chat" });
    const id = session.id;

    store.append(id, userMsg("hello")); // turn 1
    store.append(id, assistantMsg("let me check")); // turn 1 response
    store.append(id, toolResultMsg("call_1", "output1")); // turn 1 response
    store.append(id, assistantMsg("here you go")); // turn 1 response
    store.append(id, userMsg("thanks, now do X")); // turn 2
    store.append(id, assistantMsg("done")); // turn 2 response
    store.append(id, userMsg("one more thing")); // turn 3
    store.append(id, assistantMsg("running tool")); // turn 3 response
    store.append(id, toolResultMsg("call_2", "output2")); // turn 3 response
    store.append(id, assistantMsg("all done")); // turn 3 response

    return id;
  }

  async function deleteMessages(sessionId: string, params: Record<string, string>): Promise<Response> {
    const qs = new URLSearchParams(params).toString();
    const url = `http://localhost/api/sessions/${sessionId}/messages${qs ? `?${qs}` : ""}`;
    return app.handle(new Request(url, { method: "DELETE" }));
  }

  // ---------------------------------------------------------------------------
  // keep=0 (clear all)
  // ---------------------------------------------------------------------------

  test("keep=0 clears all messages", async () => {
    const id = createTestSession();
    const res = await deleteMessages(id, { keep: "0" });
    expect(res.status).toBe(200);

    const messages = store.getMessages(id);
    expect(messages.length).toBe(0);
  });

  test("no keep param clears all messages", async () => {
    const id = createTestSession();
    const res = await deleteMessages(id, {});
    expect(res.status).toBe(200);

    const messages = store.getMessages(id);
    expect(messages.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // keep N complete turns (without includeTrailing)
  // ---------------------------------------------------------------------------

  test("keep=1 keeps first complete turn (user + all assistant/tool responses)", async () => {
    const id = createTestSession();
    const res = await deleteMessages(id, { keep: "1" });
    expect(res.status).toBe(200);

    const messages = store.getMessages(id);
    // Turn 1: user₁, assistant₁, toolResult₁, assistant₁b = 4 messages
    expect(messages.length).toBe(4);
    expect(messages[0]!.role).toBe("user");
    expect(textOf(messages[0]!)).toBe("hello");
    expect(textOf(messages[3]!)).toBe("here you go");
  });

  test("keep=2 keeps first two complete turns", async () => {
    const id = createTestSession();
    const res = await deleteMessages(id, { keep: "2" });
    expect(res.status).toBe(200);

    const messages = store.getMessages(id);
    // Turn 1: 4 messages + Turn 2: user₂ + assistant₂ = 6 messages
    expect(messages.length).toBe(6);
    expect(textOf(messages[4]!)).toBe("thanks, now do X");
    expect(textOf(messages[5]!)).toBe("done");
  });

  test("keep=3 keeps all messages (only 3 turns exist)", async () => {
    const id = createTestSession();
    const res = await deleteMessages(id, { keep: "3" });
    expect(res.status).toBe(200);

    const messages = store.getMessages(id);
    expect(messages.length).toBe(10);
  });

  test("keep exceeding turn count keeps everything", async () => {
    const id = createTestSession();
    const res = await deleteMessages(id, { keep: "99" });
    expect(res.status).toBe(200);

    const messages = store.getMessages(id);
    expect(messages.length).toBe(10);
  });

  // ---------------------------------------------------------------------------
  // keep N turns + includeTrailing (keeps user message of next turn)
  // ---------------------------------------------------------------------------

  test("keep=1 + includeTrailing keeps turn 1 + user₂ only", async () => {
    const id = createTestSession();
    const res = await deleteMessages(id, { keep: "1", includeTrailing: "true" });
    expect(res.status).toBe(200);

    const messages = store.getMessages(id);
    // Turn 1 (4 msgs) + user₂ (1 msg) = 5 messages
    expect(messages.length).toBe(5);
    expect(messages[4]!.role).toBe("user");
    expect(textOf(messages[4]!)).toBe("thanks, now do X");
  });

  test("keep=2 + includeTrailing keeps turns 1-2 + user₃ only", async () => {
    const id = createTestSession();
    const res = await deleteMessages(id, { keep: "2", includeTrailing: "true" });
    expect(res.status).toBe(200);

    const messages = store.getMessages(id);
    // Turn 1 (4) + Turn 2 (2) + user₃ (1) = 7 messages
    expect(messages.length).toBe(7);
    expect(messages[6]!.role).toBe("user");
    expect(textOf(messages[6]!)).toBe("one more thing");
  });

  test("keep=0 + includeTrailing keeps only the first user message", async () => {
    const id = createTestSession();
    const res = await deleteMessages(id, { keep: "0", includeTrailing: "true" });
    expect(res.status).toBe(200);

    const messages = store.getMessages(id);
    expect(messages.length).toBe(1);
    expect(messages[0]!.role).toBe("user");
    expect(textOf(messages[0]!)).toBe("hello");
  });

  test("keep=3 + includeTrailing keeps everything (no 4th user message)", async () => {
    const id = createTestSession();
    const res = await deleteMessages(id, { keep: "3", includeTrailing: "true" });
    expect(res.status).toBe(200);

    const messages = store.getMessages(id);
    expect(messages.length).toBe(10);
  });

  // ---------------------------------------------------------------------------
  // Use case: regenerate (keep N-1 complete turns + trailing user message)
  // ---------------------------------------------------------------------------

  test("regenerate turn 3: keep=2 + includeTrailing preserves user₃ without response", async () => {
    const id = createTestSession();
    const res = await deleteMessages(id, { keep: "2", includeTrailing: "true" });
    expect(res.status).toBe(200);

    const messages = store.getMessages(id);
    // Turns 1-2 complete + user₃ without its assistant response
    expect(messages.length).toBe(7);
    const last = messages[messages.length - 1]!;
    expect(last.role).toBe("user");
    expect(textOf(last)).toBe("one more thing");
  });

  test("regenerate turn 1: keep=0 + includeTrailing preserves user₁ without response", async () => {
    const id = createTestSession();
    const res = await deleteMessages(id, { keep: "0", includeTrailing: "true" });
    expect(res.status).toBe(200);

    const messages = store.getMessages(id);
    expect(messages.length).toBe(1);
    expect(messages[0]!.role).toBe("user");
    expect(textOf(messages[0]!)).toBe("hello");
  });

  // ---------------------------------------------------------------------------
  // Use case: edit user₂ (keep turns before edited message)
  // ---------------------------------------------------------------------------

  test("edit user₂: keep=1 removes everything from turn 2 onward", async () => {
    const id = createTestSession();
    const res = await deleteMessages(id, { keep: "1" });
    expect(res.status).toBe(200);

    const messages = store.getMessages(id);
    // Only turn 1 remains
    expect(messages.length).toBe(4);
    expect(textOf(messages[messages.length - 1]!)).toBe("here you go");
  });

  // ---------------------------------------------------------------------------
  // Use case: delete assistant₂ (keep 1 complete turn + trailing user₂)
  // ---------------------------------------------------------------------------

  test("delete assistant₂: keep=1 + includeTrailing keeps turn 1 + user₂", async () => {
    const id = createTestSession();
    const res = await deleteMessages(id, { keep: "1", includeTrailing: "true" });
    expect(res.status).toBe(200);

    const messages = store.getMessages(id);
    expect(messages.length).toBe(5);
    const last = messages[messages.length - 1]!;
    expect(last.role).toBe("user");
    expect(textOf(last)).toBe("thanks, now do X");
  });

  // ---------------------------------------------------------------------------
  // Edge case: single-turn session
  // ---------------------------------------------------------------------------

  test("single turn: keep=1 keeps everything", async () => {
    const session = store.create({ source: "chat" });
    store.append(session.id, userMsg("only message"));
    store.append(session.id, assistantMsg("only response"));

    const res = await deleteMessages(session.id, { keep: "1" });
    expect(res.status).toBe(200);

    const messages = store.getMessages(session.id);
    expect(messages.length).toBe(2);
  });

  test("single turn: keep=0 + includeTrailing keeps just user message", async () => {
    const session = store.create({ source: "chat" });
    store.append(session.id, userMsg("only message"));
    store.append(session.id, assistantMsg("only response"));

    const res = await deleteMessages(session.id, { keep: "0", includeTrailing: "true" });
    expect(res.status).toBe(200);

    const messages = store.getMessages(session.id);
    expect(messages.length).toBe(1);
    expect(messages[0]!.role).toBe("user");
  });

  // ---------------------------------------------------------------------------
  // Error cases
  // ---------------------------------------------------------------------------

  test("returns 404 for non-existent session", async () => {
    const res = await deleteMessages("nonexistent-id", { keep: "1" });
    expect(res.status).toBe(404);
  });
});
