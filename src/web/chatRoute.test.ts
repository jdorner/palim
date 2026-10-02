import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PERMISSIONS, ROLE_USER } from "@shared/auth";
import { AuthService, UserStore } from "@src/auth";
import { createTestDb, type TestDb } from "@src/auth/testDb";
import type { ChatJob } from "@src/jobs";
import type { ManagedQueuePort } from "@src/queue";
import { SessionStore, setSessionStoreForTests } from "@src/session";
import { Elysia } from "elysia";
import { chatRoutes } from "./routes/chat";
import { authCheck } from "./server";

describe("chat route identity stamping", () => {
  let ctx: TestDb;
  let store: UserStore;
  let auth: AuthService;
  let sessions: SessionStore;
  let app: ReturnType<typeof buildApp>;
  let aliceId: string;
  let lastJob: ChatJob | null = null;

  /** A fake chat queue that records the enqueued job payload. */
  const fakeQueue = {
    add: async (_name: string, data: ChatJob) => {
      lastJob = data;
      return "job-1";
    },
  } as unknown as ManagedQueuePort<ChatJob>;

  /** Builds the test app: authCheck hook + chat routes over the fake queue. */
  function buildApp() {
    return new Elysia().onBeforeHandle((c) => authCheck(c as never, auth)).use(chatRoutes(fakeQueue));
  }

  async function seed(username: string): Promise<string> {
    const passwordHash = await auth.hashPassword("pw");
    const user = store.createUser({ username, passwordHash });
    const role = store.getRoleByName(ROLE_USER) ?? store.createRole(ROLE_USER, undefined, true);
    store.setRolePermissions(role.id, [PERMISSIONS.CHAT_WRITE] as never);
    store.setUserRoles(user.id, [role.id]);
    return user.id;
  }

  async function login(username: string): Promise<string> {
    const res = await auth.login(username, "pw");
    return res?.token ?? "";
  }

  beforeAll(async () => {
    ctx = createTestDb();
    sessions = new SessionStore(ctx.db);
    setSessionStoreForTests(sessions);
    store = new UserStore(ctx.db);
    auth = new AuthService(store, { passwordCost: { memoryCost: 256, timeCost: 1 } });
    aliceId = await seed("alice");
    await seed("bob");
    app = buildApp();
  });

  afterAll(() => {
    setSessionStoreForTests(null);
    ctx.sqlite.close();
  });

  test("creates a session owned by the caller and stamps initiatorUserId on the job", async () => {
    lastJob = null;
    const token = await login("alice");
    const res = await app.handle(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello", chatId: "conv-alice-1" }),
      }),
    );
    expect(res.status).toBe(201);
    const { sessionId } = (await res.json()) as { sessionId: string };

    expect(sessions.get(sessionId)?.userId).toBe(aliceId);
    const captured = lastJob as ChatJob | null;
    expect(captured?.initiatorUserId).toBe(aliceId);
    expect(captured?.sessionId).toBe(sessionId);
  });

  test("rejects posting into another user's session with 404", async () => {
    // Alice creates a session.
    const aliceToken = await login("alice");
    const first = await app.handle(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: "mine", chatId: "conv-alice-2" }),
      }),
    );
    const { sessionId } = (await first.json()) as { sessionId: string };

    // Bob tries to post into Alice's session by id.
    const bobToken = await login("bob");
    const res = await app.handle(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { Authorization: `Bearer ${bobToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: "intrude", chatId: "conv-bob-1", sessionId }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("rejects posting into another user's session via its chat ID with 404", async () => {
    // Alice creates a session keyed by her chat ID.
    const aliceToken = await login("alice");
    const first = await app.handle(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: "mine", chatId: "conv-alice-3" }),
      }),
    );
    const { sessionId } = (await first.json()) as { sessionId: string };
    const before = sessions.getMessages(sessionId).length;

    // Bob reuses Alice's chat ID without a session ID.
    lastJob = null;
    const bobToken = await login("bob");
    const res = await app.handle(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { Authorization: `Bearer ${bobToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: "intrude", chatId: "conv-alice-3" }),
      }),
    );
    expect(res.status).toBe(404);
    expect(lastJob).toBeNull();
    expect(sessions.getMessages(sessionId).length).toBe(before);
  });
});
