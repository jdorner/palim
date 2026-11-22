/**
 * Tests for the session routes DELETE endpoint turn-based truncation logic.
 *
 * Exercises the Elysia route handler via `.handle()` using a fresh
 * in-memory SQLite database for each test.
 *
 * Because `getSessionStore()` is a module-level singleton that only
 * initializes once, we call it once with the first DB and then use
 * unique sourceIds per test to avoid conflicts.
 *
 * Requests run as an admin principal so these tests exercise the truncation
 * and deletion logic only; ownership checks are covered in
 * `src/web/sessionsRoute.test.ts`.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { buildAbility } from "@src/auth/ability";
import { getSessionStore, type SessionStore } from "@src/session";
import { createTestDb } from "@src/test/db";
import { Elysia } from "elysia";
import { setPrincipal } from "../auth";
import type { ChatSessionGuard } from "../chatSessionGuard";
import { sessionRoutes } from "./sessions";

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

/** A guard that reports the session as busy while `busy` holds its ID. */
const busy = new Set<string>();
const guard: ChatSessionGuard = { claim: async (id) => !busy.has(id), release: () => {} };

/** Session changes the routes announced: [sessionId, reason, origin]. */
const notified: [string, string, string | undefined][] = [];

/** Builds the session routes with every request authenticated as an admin. */
function buildAdminApp() {
  const adminId = "test-admin";
  return new Elysia()
    .onRequest(({ request }) =>
      setPrincipal(request, {
        user: { id: adminId, username: "admin", roles: ["admin"], kind: "operator" },
        isAdmin: true,
        permissions: [],
        ability: buildAbility({ userId: adminId, isAdmin: true, permissions: [] }),
      }),
    )
    .use(sessionRoutes(guard, (id, reason, origin) => notified.push([id, reason, origin])));
}

describe("DELETE /api/sessions/:id/messages (turn-based truncation)", () => {
  let store: SessionStore;
  let app: ReturnType<typeof buildAdminApp>;

  beforeAll(() => {
    // Initialize the singleton once - all tests share this DB instance
    const db = createTestDb();
    store = getSessionStore(db);
    app = buildAdminApp();
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

  test("a truncation that deletes messages is announced with the request's origin", async () => {
    const id = store.create({ source: "chat" }).id;
    store.append(id, userMsg("a"), { clientId: "u1" });
    store.append(id, assistantMsg("b"));
    notified.length = 0;

    expect((await deleteMessages(id, { after: "u1", origin: "req-1" })).status).toBe(200);
    expect(notified).toEqual([[id, "truncate", "req-1"]]);

    // Nothing left to delete: nothing changed, nothing announced.
    expect((await deleteMessages(id, { after: "u1", origin: "req-2" })).status).toBe(200);
    expect(notified).toHaveLength(1);
  });

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

  test("returns 409 while a chat job is pending for the session", async () => {
    const id = createTestSession();
    busy.add(id);
    try {
      const res = await deleteMessages(id, { keep: "1" });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe("session_busy");
      expect(store.getMessages(id).length).toBe(10);
    } finally {
      busy.delete(id);
    }
  });
});

describe("DELETE /api/sessions/:id/messages (by client message ID)", () => {
  let store: SessionStore;
  let app: ReturnType<typeof buildAdminApp>;

  beforeAll(() => {
    store = getSessionStore(createTestDb());
    app = buildAdminApp();
  });

  /** u1 → a1 → tool → a1' → u2 → a2 → u3 → a3, user messages carrying client IDs c1..c3. */
  function createSession(withIds: [boolean, boolean, boolean] = [true, true, true]): string {
    const id = store.create({ source: "chat" }).id;
    const user = (n: number) => store.append(id, userMsg(`u${n}`), withIds[n - 1] ? { clientId: `c${n}` } : undefined);
    user(1);
    store.append(id, assistantMsg("a1"));
    store.append(id, toolResultMsg("call_1", "out"));
    store.append(id, assistantMsg("a1'"));
    user(2);
    store.append(id, assistantMsg("a2"));
    user(3);
    store.append(id, assistantMsg("a3"));
    return id;
  }

  async function deleteMessages(sessionId: string, params: Record<string, string>): Promise<Response> {
    const qs = new URLSearchParams(params).toString();
    return app.handle(new Request(`http://localhost/api/sessions/${sessionId}/messages?${qs}`, { method: "DELETE" }));
  }

  const texts = (id: string) => store.getMessages(id).map(textOf);

  test("from deletes the user message and everything after it", async () => {
    const id = createSession();
    expect((await deleteMessages(id, { from: "c2" })).status).toBe(200);
    expect(texts(id)).toEqual(["u1", "a1", "out", "a1'"]);
  });

  test("after keeps the user message and deletes its response and later turns", async () => {
    const id = createSession();
    expect((await deleteMessages(id, { after: "c2" })).status).toBe(200);
    expect(texts(id)).toEqual(["u1", "a1", "out", "a1'", "u2"]);
  });

  test("from on the first message clears the session", async () => {
    const id = createSession();
    expect((await deleteMessages(id, { from: "c1" })).status).toBe(200);
    expect(texts(id)).toEqual([]);
  });

  test("an unknown ID in a session with IDs returns 409 and changes nothing", async () => {
    const id = createSession();
    const res = await deleteMessages(id, { from: "nope", keep: "1" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("session_diverged");
    expect(texts(id).length).toBe(8);
  });

  test("an unknown ID in a session with legacy messages falls back to counting turns", async () => {
    const id = createSession([false, false, true]);
    expect((await deleteMessages(id, { from: "ui-2", keep: "1" })).status).toBe(200);
    expect(texts(id)).toEqual(["u1", "a1", "out", "a1'"]);
  });

  test("after on a legacy message stores its client ID", async () => {
    const id = createSession([false, false, false]);
    expect((await deleteMessages(id, { after: "ui-2", keep: "1", includeTrailing: "true" })).status).toBe(200);
    expect(texts(id)).toEqual(["u1", "a1", "out", "a1'", "u2"]);
    expect(store.getUserMessageMarkers(id).map((m) => m.clientId)).toEqual([null, "ui-2"]);
  });

  test("an unknown ID without a count fallback returns 409 even with legacy messages", async () => {
    const id = createSession([false, false, false]);
    expect((await deleteMessages(id, { from: "ui-2" })).status).toBe(409);
    expect(texts(id).length).toBe(8);
  });

  test("an ID stored in a mixed session is found directly", async () => {
    const id = createSession([false, false, true]);
    expect((await deleteMessages(id, { after: "c3", keep: "0" })).status).toBe(200);
    expect(texts(id)).toEqual(["u1", "a1", "out", "a1'", "u2", "a2", "u3"]);
  });
});

describe("DELETE /api/sessions/:id (session deletion)", () => {
  let store: SessionStore;
  let app: ReturnType<typeof buildAdminApp>;

  beforeAll(() => {
    // Reuse the shared singleton (initialized by the suite above). Passing a db
    // is a no-op once the singleton exists, so this is safe regardless of order.
    store = getSessionStore(createTestDb());
    app = buildAdminApp();
  });

  async function deleteSession(sessionId: string): Promise<Response> {
    return app.handle(new Request(`http://localhost/api/sessions/${sessionId}`, { method: "DELETE" }));
  }

  test("deletes the session and its messages", async () => {
    const session = store.create({ source: "chat", sourceId: `del-${Date.now()}` });
    store.append(session.id, userMsg("hello"));
    store.append(session.id, assistantMsg("hi"));

    const res = await deleteSession(session.id);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { sessionId: string; ok: boolean };
    expect(body.ok).toBe(true);
    expect(body.sessionId).toBe(session.id);

    expect(store.get(session.id)).toBeUndefined();
    expect(store.getMessages(session.id)).toEqual([]);
  });

  test("returns 404 for a non-existent session", async () => {
    const res = await deleteSession("nonexistent-id");
    expect(res.status).toBe(404);
  });
});
