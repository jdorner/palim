import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PERMISSIONS, ROLE_USER } from "@shared/auth";
import { AuthService, UserStore } from "@src/auth";
import { createTestDb, type TestDb } from "@src/auth/testDb";
import type { ChatJob } from "@src/jobs";
import type { ManagedQueuePort } from "@src/queue";
import { SessionStore, setSessionStoreForTests } from "@src/session";
import { Elysia } from "elysia";
import { createChatSessionGuard } from "./chatSessionGuard";
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
  /** Session changes the route announced: [sessionId, reason, origin]. */
  const notified: [string, string, string | undefined][] = [];

  /** Jobs the fake queue reports as active (to simulate a running chat job). */
  let activeJobs: ChatJob[] = [];

  /** A fake chat queue that records the enqueued job payload. */
  const fakeQueue = {
    add: async (_name: string, data: ChatJob) => {
      lastJob = data;
      return "job-1";
    },
    getWaiting: async () => [],
    getActive: async () => activeJobs.map((data) => ({ data })),
  } as unknown as ManagedQueuePort<ChatJob>;

  /** Builds the test app: authCheck hook + chat routes over the fake queue. */
  function buildApp() {
    return new Elysia()
      .onBeforeHandle((c) => authCheck(c as never, auth))
      .use(
        chatRoutes(fakeQueue, createChatSessionGuard(fakeQueue), undefined, (id, reason, origin) =>
          notified.push([id, reason, origin]),
        ),
      );
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
    // Other tabs learn about the message; the chat ID lets the sender skip it.
    expect(notified.at(-1)).toEqual([sessionId, "message", "conv-alice-1"]);
  });

  test("names a new session after the client's conversation ID, and finds it again by that ID", async () => {
    const token = await login("alice");
    const send = (chatId: string) =>
      app.handle(
        new Request("http://localhost/api/chat", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ message: "hello", chatId, conversationId: "conv-uuid-1" }),
        }),
      );
    const first = (await (await send("chat-a")).json()) as { sessionId: string };
    expect(sessions.get(first.sessionId)?.sourceId).toBe("conv-uuid-1");
    // A retry without the session ID (the first response never arrived) lands in the same session.
    const second = (await (await send("chat-b")).json()) as { sessionId: string };
    expect(second.sessionId).toBe(first.sessionId);
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

  describe("client message IDs", () => {
    /** Posts as alice and returns the response. */
    async function post(body: Record<string, unknown>): Promise<Response> {
      const token = await login("alice");
      return app.handle(
        new Request("http://localhost/api/chat", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    }

    /** Starts a session with user message `m1` and an assistant answer. */
    async function start(chatId: string): Promise<string> {
      const res = await post({ message: "first", chatId, clientMessageId: "m1", expectedLastClientId: null });
      expect(res.status).toBe(201);
      const { sessionId } = (await res.json()) as { sessionId: string };
      sessions.append(sessionId, {
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
        timestamp: Date.now(),
      } as never);
      return sessionId;
    }

    const roles = (sessionId: string) => sessions.getMessages(sessionId).map((m) => m.role);

    test("stores the client ID and appends a new message whose predecessor matches", async () => {
      const sessionId = await start("conv-ids-1");
      const res = await post({
        message: "second",
        chatId: "x",
        sessionId,
        clientMessageId: "m2",
        expectedLastClientId: "m1",
      });
      expect(res.status).toBe(201);
      expect(sessions.getUserMessageMarkers(sessionId).map((m) => m.clientId)).toEqual(["m1", "m2"]);
    });

    test("resending the last user message reruns it without appending", async () => {
      const sessionId = await start("conv-ids-2");
      lastJob = null;
      const res = await post({
        message: "first",
        chatId: "x",
        sessionId,
        clientMessageId: "m1",
        expectedLastClientId: null,
      });
      expect(res.status).toBe(201);
      expect(roles(sessionId)).toEqual(["user"]);
      expect(lastJob as ChatJob | null).not.toBeNull();
    });

    test("returns 409 when the expected predecessor does not match", async () => {
      const sessionId = await start("conv-ids-3");
      lastJob = null;
      const res = await post({
        message: "second",
        chatId: "x",
        sessionId,
        clientMessageId: "m2",
        expectedLastClientId: "other",
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe("session_diverged");
      expect(roles(sessionId)).toEqual(["user", "assistant"]);
      expect(lastJob).toBeNull();
    });

    test("returns 409 when resending a user message that is not the last one", async () => {
      const sessionId = await start("conv-ids-4");
      await post({ message: "second", chatId: "x", sessionId, clientMessageId: "m2", expectedLastClientId: "m1" });
      const res = await post({
        message: "first",
        chatId: "x",
        sessionId,
        clientMessageId: "m1",
        expectedLastClientId: null,
      });
      expect(res.status).toBe(409);
    });

    test("a user message stored without client ID is matched by legacy-<seq>", async () => {
      const sessionId = await start("conv-ids-5");
      sessions.append(sessionId, { role: "user", content: "no id", timestamp: Date.now() } as never);
      const legacyId = `legacy-${sessions.getUserMessageMarkers(sessionId).at(-1)!.seq}`;

      const wrong = await post({
        message: "next",
        chatId: "x",
        sessionId,
        clientMessageId: "m3",
        expectedLastClientId: "m1",
      });
      expect(wrong.status).toBe(409);

      const res = await post({
        message: "next",
        chatId: "x",
        sessionId,
        clientMessageId: "m3",
        expectedLastClientId: legacyId,
      });
      expect(res.status).toBe(201);
    });

    test("returns 409 while a chat job for the session is pending", async () => {
      const sessionId = await start("conv-ids-6");
      activeJobs = [{ context: { source: "chat", id: "x" }, sessionId }];
      try {
        lastJob = null;
        const res = await post({
          message: "second",
          chatId: "x",
          sessionId,
          clientMessageId: "m2",
          expectedLastClientId: "m1",
        });
        expect(res.status).toBe(409);
        expect(((await res.json()) as { code: string }).code).toBe("session_busy");
        expect(roles(sessionId)).toEqual(["user", "assistant"]);
        expect(lastJob).toBeNull();
      } finally {
        activeJobs = [];
      }
    });
  });
});
