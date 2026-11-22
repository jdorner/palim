/**
 * Tests for the session routes DELETE endpoints (truncation by client message ID, deletion).
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

describe("DELETE /api/sessions/:id/messages", () => {
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

  test("without from or after, every message goes", async () => {
    const id = createTestSession();
    expect((await deleteMessages(id, {})).status).toBe(200);
    expect(store.getMessages(id).length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Error cases
  // ---------------------------------------------------------------------------

  test("returns 404 for non-existent session", async () => {
    const res = await deleteMessages("nonexistent-id", {});
    expect(res.status).toBe(404);
  });

  test("returns 409 while a chat job is pending for the session", async () => {
    const id = createTestSession();
    busy.add(id);
    try {
      const res = await deleteMessages(id, {});
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

  test("an unknown ID returns 409 and changes nothing", async () => {
    const id = createSession();
    const res = await deleteMessages(id, { from: "nope" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("session_diverged");
    expect(texts(id).length).toBe(8);
  });

  test("a user message stored without client ID is found by legacy-<seq>", async () => {
    const id = createSession([true, false, true]);
    const seq = store.getUserMessageMarkers(id)[1]!.seq;
    expect((await deleteMessages(id, { after: `legacy-${seq}` })).status).toBe(200);
    expect(texts(id)).toEqual(["u1", "a1", "out", "a1'", "u2"]);
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
