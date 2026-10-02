import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PERMISSIONS, ROLE_ADMIN, ROLE_USER } from "@shared/auth";
import { AuthService, UserStore } from "@src/auth";
import { createTestDb, type TestDb } from "@src/auth/testDb";
import { Elysia } from "elysia";
import { authRoutes } from "./routes/auth";
import { authCheck } from "./server";

/** Builds a minimal Elysia app wiring the real authCheck hook + auth routes. */
function buildApp(auth: AuthService) {
  return (
    new Elysia()
      .onBeforeHandle((ctx) => authCheck(ctx as never, auth))
      .use(authRoutes(() => auth))
      // A protected admin-only endpoint (matches the /api/users authorization rule).
      .get("/api/users", ({ status }) => status(200, { ok: true }))
      // A protected non-admin endpoint that matches no rule (auth only).
      .post("/api/chat", ({ status }) => status(200, { ok: true }))
  );
}

/** Seeds a user with roles + permissions using low-cost hashing. */
async function seedUser(
  auth: AuthService,
  store: UserStore,
  username: string,
  password: string,
  roleSpecs: { name: string; permissions?: readonly string[] }[],
): Promise<void> {
  const passwordHash = await auth.hashPassword(password);
  const user = store.createUser({ username, passwordHash });
  const roleIds: string[] = [];
  for (const spec of roleSpecs) {
    const role = store.getRoleByName(spec.name) ?? store.createRole(spec.name, undefined, true);
    if (spec.permissions) store.setRolePermissions(role.id, spec.permissions as never);
    roleIds.push(role.id);
  }
  store.setUserRoles(user.id, roleIds);
}

describe("web auth (authCheck + auth routes)", () => {
  let ctx: TestDb;
  let store: UserStore;
  let auth: AuthService;
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    ctx = createTestDb();
    store = new UserStore(ctx.db);
    auth = new AuthService(store, { passwordCost: { memoryCost: 256, timeCost: 1 } });
    await seedUser(auth, store, "admin", "adminpw", [{ name: ROLE_ADMIN }]);
    await seedUser(auth, store, "alice", "alicepw", [{ name: ROLE_USER, permissions: [PERMISSIONS.CHAT_WRITE] }]);
    app = buildApp(auth);
  });

  afterEach(() => {
    ctx.sqlite.close();
  });

  /** Logs in and returns the bearer token. */
  async function login(username: string, password: string): Promise<string> {
    const res = await app.handle(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      }),
    );
    const body = (await res.json()) as { token: string };
    return body.token;
  }

  describe("login", () => {
    test("returns a token, user, and ability for valid credentials", async () => {
      const res = await app.handle(
        new Request("http://localhost/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "alice", password: "alicepw" }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string; user: { username: string }; ability: unknown };
      expect(body.token.length).toBeGreaterThan(0);
      expect(body.user.username).toBe("alice");
      expect(body.ability).toBeDefined();
    });

    test("rejects invalid credentials with 401", async () => {
      const res = await app.handle(
        new Request("http://localhost/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "alice", password: "wrong" }),
        }),
      );
      expect(res.status).toBe(401);
    });
  });

  describe("protected routes", () => {
    test("401 without a token", async () => {
      const res = await app.handle(new Request("http://localhost/api/chat", { method: "POST" }));
      expect(res.status).toBe(401);
    });

    test("401 with a bogus token", async () => {
      const res = await app.handle(
        new Request("http://localhost/api/chat", {
          method: "POST",
          headers: { Authorization: "Bearer not-a-real-token" },
        }),
      );
      expect(res.status).toBe(401);
    });

    test("200 with a valid token on a no-rule route", async () => {
      const token = await login("alice", "alicepw");
      const res = await app.handle(
        new Request("http://localhost/api/chat", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      expect(res.status).toBe(200);
    });

    test("403 when a user lacks the required permission", async () => {
      const token = await login("alice", "alicepw");
      const res = await app.handle(
        new Request("http://localhost/api/users", {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      expect(res.status).toBe(403);
    });

    test("200 when an admin hits the admin-only route", async () => {
      const token = await login("admin", "adminpw");
      const res = await app.handle(
        new Request("http://localhost/api/users", {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      expect(res.status).toBe(200);
    });
  });

  describe("me and logout", () => {
    test("me returns the authenticated user and ability", async () => {
      const token = await login("alice", "alicepw");
      const res = await app.handle(
        new Request("http://localhost/api/auth/me", {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { user: { username: string }; ability: { isAdmin: boolean } };
      expect(body.user.username).toBe("alice");
      expect(body.ability.isAdmin).toBe(false);
    });

    test("logout invalidates the token", async () => {
      const token = await login("alice", "alicepw");
      const logoutRes = await app.handle(
        new Request("http://localhost/api/auth/logout", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      expect(logoutRes.status).toBe(200);

      const meRes = await app.handle(
        new Request("http://localhost/api/auth/me", {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      expect(meRes.status).toBe(401);
    });
  });
});
