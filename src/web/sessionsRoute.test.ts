import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PERMISSIONS, ROLE_ADMIN, ROLE_USER } from "@shared/auth";
import { AuthService, UserStore } from "@src/auth";
import { createTestDb, type TestDb } from "@src/auth/testDb";
import { SessionStore, setSessionStoreForTests } from "@src/session";
import { Elysia } from "elysia";
import { sessionRoutes } from "./routes/sessions";
import { authCheck } from "./server";

describe("session routes ownership", () => {
  let ctx: TestDb;
  let store: UserStore;
  let auth: AuthService;
  let sessions: SessionStore;
  let app: ReturnType<typeof buildApp>;
  let aliceId: string;
  let bobId: string;

  function buildApp(a: AuthService) {
    return new Elysia()
      .onBeforeHandle((c) => authCheck(c as never, a))
      .use(sessionRoutes({ claim: async () => true, release: () => {} }));
  }

  async function seed(username: string, roleName: string, perms?: readonly string[]): Promise<string> {
    const passwordHash = await auth.hashPassword("pw");
    const user = store.createUser({ username, passwordHash });
    const role = store.getRoleByName(roleName) ?? store.createRole(roleName, undefined, true);
    if (perms) store.setRolePermissions(role.id, perms as never);
    store.setUserRoles(user.id, [role.id]);
    return user.id;
  }

  async function login(username: string): Promise<string> {
    const res = await auth.login(username, "pw");
    return res?.token ?? "";
  }

  beforeAll(async () => {
    ctx = createTestDb();
    // Bind the session-store singleton to this test's DB.
    sessions = new SessionStore(ctx.db);
    setSessionStoreForTests(sessions);
    store = new UserStore(ctx.db);
    auth = new AuthService(store, { passwordCost: { memoryCost: 256, timeCost: 1 } });
    aliceId = await seed("alice", ROLE_USER, [PERMISSIONS.CHAT_WRITE]);
    bobId = await seed("bob", ROLE_USER, [PERMISSIONS.CHAT_WRITE]);
    await seed("root", ROLE_ADMIN);
    app = buildApp(auth);
    void bobId;
  });

  afterAll(() => {
    setSessionStoreForTests(null);
    ctx.sqlite.close();
  });

  test("owner can read their own session messages", async () => {
    const session = sessions.create({ source: "chat", sourceId: "own-read", userId: aliceId });
    const token = await login("alice");
    const res = await app.handle(
      new Request(`http://localhost/api/sessions/${session.id}/messages`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
  });

  test("a different user gets 404 for someone else's session", async () => {
    const session = sessions.create({ source: "chat", sourceId: "alice-only", userId: aliceId });
    const token = await login("bob");
    const res = await app.handle(
      new Request(`http://localhost/api/sessions/${session.id}/messages`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(404);
  });

  test("admin can read any user's session", async () => {
    const session = sessions.create({ source: "chat", sourceId: "admin-read", userId: aliceId });
    const token = await login("root");
    const res = await app.handle(
      new Request(`http://localhost/api/sessions/${session.id}/messages`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
  });

  test("a non-owner cannot delete another user's session", async () => {
    const session = sessions.create({ source: "chat", sourceId: "no-delete", userId: aliceId });
    const token = await login("bob");
    const res = await app.handle(
      new Request(`http://localhost/api/sessions/${session.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(404);
    expect(sessions.get(session.id)).not.toBeUndefined();
  });

  test("owner can delete their own session", async () => {
    const session = sessions.create({ source: "chat", sourceId: "self-delete", userId: aliceId });
    const token = await login("alice");
    const res = await app.handle(
      new Request(`http://localhost/api/sessions/${session.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(sessions.get(session.id)).toBeUndefined();
  });

  /** Sends an authenticated GET and returns status and JSON body. */
  async function get(path: string, username: string): Promise<{ status: number; body: any }> {
    const token = await login(username);
    const res = await app.handle(
      new Request(`http://localhost${path}`, { headers: { Authorization: `Bearer ${token}` } }),
    );
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  test("GET /api/sessions lists only the caller's sessions of the source, with a derived title", async () => {
    const mine = sessions.create({ source: "chat", sourceId: "list-mine", userId: aliceId });
    sessions.append(mine.id, { role: "user", content: "  Hello there  ", timestamp: 1 }, { clientId: "c1" });
    sessions.append(mine.id, { role: "user", content: "second", timestamp: 2 }, { clientId: "c2" });
    const empty = sessions.create({ source: "chat", sourceId: "list-empty", userId: aliceId });
    const other = sessions.create({ source: "chat", sourceId: "list-bob", userId: bobId });
    sessions.append(other.id, { role: "user", content: "bob's", timestamp: 1 }, { clientId: "b1" });
    const telegram = sessions.create({ source: "telegram", sourceId: "list-tg", userId: aliceId });
    sessions.append(telegram.id, { role: "user", content: "tg", timestamp: 1 });

    const { status, body } = await get("/api/sessions?source=chat", "alice");
    expect(status).toBe(200);
    const ids = body.sessions.map((s: { id: string }) => s.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(empty.id);
    expect(ids).not.toContain(other.id);
    expect(ids).not.toContain(telegram.id);
    expect(body.sessions.find((s: { id: string }) => s.id === mine.id)).toMatchObject({
      title: "Hello there",
      lastUserClientId: "c2",
    });
  });

  test("GET /api/sessions requires a source", async () => {
    expect((await get("/api/sessions", "alice")).status).toBe(422);
  });

  test("GET /api/sessions/:id/chat converts the session for its owner only", async () => {
    const session = sessions.create({ source: "chat", sourceId: "chat-convert", userId: aliceId });
    sessions.append(session.id, { role: "user", content: "hi", timestamp: 1 }, { clientId: "u1" });
    sessions.append(session.id, {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      timestamp: 2,
      usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 4 },
    } as never);

    const own = await get(`/api/sessions/${session.id}/chat`, "alice");
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ id: session.id, title: "hi", lastUserClientId: "u1" });
    expect(own.body.messages).toEqual([
      { id: "u1", role: "user", content: "hi", createdAt: 1 },
      {
        role: "assistant",
        content: "hello",
        createdAt: 2,
        segments: [{ type: "text", content: "hello" }],
        usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 4 },
      },
    ]);

    expect((await get(`/api/sessions/${session.id}/chat`, "bob")).status).toBe(404);
  });

  test("GET /api/sessions/:id returns the summary for its owner only", async () => {
    const session = sessions.create({ source: "chat", sourceId: "summary", userId: aliceId });
    const empty = await get(`/api/sessions/${session.id}`, "alice");
    expect(empty.body).toMatchObject({ id: session.id, title: "", lastUserClientId: null });

    sessions.append(session.id, { role: "user", content: "q", timestamp: 1 }, { clientId: "u9" });
    expect((await get(`/api/sessions/${session.id}`, "alice")).body.lastUserClientId).toBe("u9");
    expect((await get(`/api/sessions/${session.id}`, "bob")).status).toBe(404);
  });

  test("a user message stored without client ID is reported with the ID the transcript gives it", async () => {
    const session = sessions.create({ source: "chat", sourceId: "summary-legacy", userId: aliceId });
    sessions.append(session.id, { role: "user", content: "old", timestamp: 1 });
    const summary = await get(`/api/sessions/${session.id}`, "alice");
    const chat = await get(`/api/sessions/${session.id}/chat`, "alice");
    expect(summary.body.lastUserClientId).toBe(chat.body.messages[0].id);
    expect(summary.body.lastUserClientId).toMatch(/^legacy-\d+$/);
  });
});
