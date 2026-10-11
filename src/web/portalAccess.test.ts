/**
 * Tests for portal accounts: HTTP fencing to the portal path prefixes, the
 * account kind on the user admin API, and the portal-safety guards on role
 * assignment and role permission edits.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PERMISSIONS, ROLE_ADMIN, ROLE_PORTAL_USER, ROLE_USER } from "@shared/auth";
import { AuthService, UserStore } from "@src/auth";
import { createTestDb, type TestDb } from "@src/auth/testDb";
import { Elysia } from "elysia";
import { authRoutes } from "./routes/auth";
import { userRoutes } from "./routes/users";
import { authCheck } from "./server";

describe("portal accounts", () => {
  let ctx: TestDb;
  let store: UserStore;
  let auth: AuthService;
  let app: ReturnType<typeof buildApp>;

  function buildApp() {
    return (
      new Elysia()
        .onBeforeHandle((c) => authCheck(c as never, auth))
        .use(authRoutes(() => auth))
        .use(
          userRoutes(
            () => store,
            () => auth,
          ),
        )
        // Stand-ins for a portal route, an i18n route, and operator routes.
        .get("/api/portal/tasks", ({ status }) => status(200, { tasks: [] }))
        .get("/api/i18n/de", ({ status }) => status(200, {}))
        .get("/api/jobs", ({ status }) => status(200, { jobs: [] }))
        .get("/ext/workflows/runs", ({ status }) => status(200, { runs: [] }))
    );
  }

  /** Creates a user of a kind holding the named roles (creating custom roles as needed). */
  async function seed(username: string, kind: "operator" | "portal", roleNames: string[]): Promise<string> {
    const passwordHash = await auth.hashPassword("pw");
    const user = store.createUser({ username, passwordHash, kind });
    const ids = roleNames.map((name) => (store.getRoleByName(name) ?? store.createRole(name, undefined, false)).id);
    store.setUserRoles(user.id, ids);
    return user.id;
  }

  async function login(username: string): Promise<string> {
    return (await auth.login(username, "pw"))?.token ?? "";
  }

  function req(method: string, path: string, token: string, body?: unknown): Request {
    return new Request(`http://localhost${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  beforeEach(async () => {
    ctx = createTestDb();
    store = new UserStore(ctx.db);
    auth = new AuthService(store, { passwordCost: { memoryCost: 256, timeCost: 1 } });
    // Built-in roles as seeded on boot.
    store.createRole(ROLE_ADMIN, undefined, true);
    store.setRolePermissions(store.createRole(ROLE_USER, undefined, true).id, [PERMISSIONS.CHAT_WRITE]);
    store.setRolePermissions(store.createRole(ROLE_PORTAL_USER, undefined, true).id, [PERMISSIONS.HITL_RESPOND]);
    await seed("root", "operator", [ROLE_ADMIN]);
    await seed("pat", "portal", [ROLE_PORTAL_USER]);
    app = buildApp();
  });

  afterEach(() => {
    ctx.sqlite.close();
  });

  describe("HTTP fencing", () => {
    test("a portal account reaches the portal, auth, and i18n APIs", async () => {
      const token = await login("pat");

      expect((await app.handle(req("GET", "/api/portal/tasks", token))).status).toBe(200);
      expect((await app.handle(req("GET", "/api/i18n/de", token))).status).toBe(200);
      const me = await app.handle(req("GET", "/api/auth/me", token));
      expect(me.status).toBe(200);
      const body = (await me.json()) as { user: { kind: string }; ability: { kind: string } };
      expect(body.user.kind).toBe("portal");
      expect(body.ability.kind).toBe("portal");
    });

    test("a portal account is refused everywhere else, even for reads", async () => {
      const token = await login("pat");

      expect((await app.handle(req("GET", "/api/jobs", token))).status).toBe(403);
      expect((await app.handle(req("GET", "/ext/workflows/runs", token))).status).toBe(403);
      expect((await app.handle(req("GET", "/api/users", token))).status).toBe(403);
    });

    test("operator accounts are not fenced", async () => {
      const token = await login("root");
      expect((await app.handle(req("GET", "/api/jobs", token))).status).toBe(200);
    });
  });

  describe("user admin API", () => {
    test("creates a portal account with the portal-user role", async () => {
      const token = await login("root");
      const portalRole = store.getRoleByName(ROLE_PORTAL_USER)!;

      const res = await app.handle(
        req("POST", "/api/users", token, {
          username: "pia",
          password: "password1",
          kind: "portal",
          roleIds: [portalRole.id],
        }),
      );

      expect(res.status).toBe(201);
      const { user } = (await res.json()) as { user: { kind: string; roles: string[] } };
      expect(user).toMatchObject({ kind: "portal", roles: [ROLE_PORTAL_USER] });
    });

    test("refuses a portal account with a role that grants more than hitl permissions", async () => {
      const token = await login("root");

      for (const roleName of [ROLE_ADMIN, ROLE_USER]) {
        const res = await app.handle(
          req("POST", "/api/users", token, {
            username: `x-${roleName}`,
            password: "password1",
            kind: "portal",
            roleIds: [store.getRoleByName(roleName)!.id],
          }),
        );
        expect(res.status).toBe(409);
      }
    });

    test("refuses switching an operator with operator roles to the portal kind", async () => {
      const token = await login("root");
      const aliceId = await seed("alice", "operator", [ROLE_USER]);

      const refused = await app.handle(req("PATCH", `/api/users/${aliceId}`, token, { kind: "portal" }));
      expect(refused.status).toBe(409);

      const allowed = await app.handle(
        req("PATCH", `/api/users/${aliceId}`, token, {
          kind: "portal",
          roleIds: [store.getRoleByName(ROLE_PORTAL_USER)!.id],
        }),
      );
      expect(allowed.status).toBe(200);
      expect(store.getUserById(aliceId)!.kind).toBe("portal");
    });

    test("an admin cannot turn their own account into a portal account", async () => {
      const token = await login("root");
      const rootId = store.getUserByUsername("root")!.id;

      const res = await app.handle(req("PATCH", `/api/users/${rootId}`, token, { kind: "portal" }));

      expect(res.status).toBe(409);
      expect(store.getUserById(rootId)!.kind).toBe("operator");
    });

    test("a role held by a portal account cannot be widened beyond hitl permissions", async () => {
      const token = await login("root");
      await seed("pam", "portal", ["reviewers"]);
      const reviewers = store.getRoleByName("reviewers")!;

      const widened = await app.handle(
        req("PUT", `/api/roles/${reviewers.id}/permissions`, token, {
          permissions: [PERMISSIONS.HITL_RESPOND, PERMISSIONS.CHAT_WRITE],
        }),
      );
      expect(widened.status).toBe(409);

      const ok = await app.handle(
        req("PUT", `/api/roles/${reviewers.id}/permissions`, token, {
          permissions: [PERMISSIONS.HITL_RESPOND, PERMISSIONS.HITL_MANAGE],
        }),
      );
      expect(ok.status).toBe(200);
    });

    test("the users listing includes the kind", async () => {
      const token = await login("root");
      const res = await app.handle(req("GET", "/api/users", token));
      const { users } = (await res.json()) as { users: { username: string; kind: string }[] };
      expect(users.find((u) => u.username === "pat")?.kind).toBe("portal");
      expect(users.find((u) => u.username === "root")?.kind).toBe("operator");
    });
  });
});
