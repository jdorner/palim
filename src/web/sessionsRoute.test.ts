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
    return new Elysia().onBeforeHandle((c) => authCheck(c as never, a)).use(sessionRoutes());
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
});
