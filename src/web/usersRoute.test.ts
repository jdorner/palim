import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PERMISSIONS, ROLE_ADMIN, ROLE_USER } from "@shared/auth";
import { AuthService, UserStore } from "@src/auth";
import { createTestDb, type TestDb } from "@src/auth/testDb";
import { Elysia } from "elysia";
import { userRoutes } from "./routes/users";
import { authCheck } from "./server";
import { registerTriggerOwnerCounter } from "./triggerOwnership";

describe("admin user/role management API", () => {
  let ctx: TestDb;
  let store: UserStore;
  let auth: AuthService;
  let app: ReturnType<typeof buildApp>;
  let deletedSessionsFor: string[];

  function buildApp() {
    return new Elysia()
      .onBeforeHandle((c) => authCheck(c as never, auth))
      .use(
        userRoutes(
          () => store,
          () => auth,
          undefined,
          (userId) => {
            deletedSessionsFor.push(userId);
            return 3;
          },
        ),
      );
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

  /** Authenticated JSON request helper. */
  function req(method: string, path: string, token: string, body?: unknown): Request {
    return new Request(`http://localhost${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  beforeEach(async () => {
    ctx = createTestDb();
    store = new UserStore(ctx.db);
    auth = new AuthService(store, { passwordCost: { memoryCost: 256, timeCost: 1 } });
    await seed("root", ROLE_ADMIN);
    await seed("alice", ROLE_USER, [PERMISSIONS.CHAT_WRITE]);
    deletedSessionsFor = [];
    app = buildApp();
  });

  afterEach(() => {
    ctx.sqlite.close();
  });

  describe("authorization", () => {
    test("a non-admin cannot list users (403)", async () => {
      const token = await login("alice");
      const res = await app.handle(req("GET", "/api/users", token));
      expect(res.status).toBe(403);
    });

    test("a non-admin cannot create a user (403)", async () => {
      const token = await login("alice");
      const res = await app.handle(req("POST", "/api/users", token, { username: "eve", password: "password1" }));
      expect(res.status).toBe(403);
    });

    test("an admin can list users (200), hashes never exposed", async () => {
      const token = await login("root");
      const res = await app.handle(req("GET", "/api/users", token));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { users: Record<string, unknown>[] };
      expect(body.users.length).toBeGreaterThan(0);
      for (const u of body.users) {
        expect(u.passwordHash).toBeUndefined();
      }
    });
  });

  describe("user CRUD", () => {
    test("admin creates a user with a role, then that user can log in", async () => {
      const adminToken = await login("root");
      const userRole = store.getRoleByName(ROLE_USER);
      const res = await app.handle(
        req("POST", "/api/users", adminToken, {
          username: "bob",
          password: "password1",
          roleIds: [userRole?.id],
        }),
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { user: { id: string; roles: string[] } };
      expect(body.user.roles).toContain(ROLE_USER);

      const login2 = await auth.login("bob", "password1");
      expect(login2).not.toBeNull();
    });

    test("duplicate username is rejected (409)", async () => {
      const adminToken = await login("root");
      const res = await app.handle(req("POST", "/api/users", adminToken, { username: "alice", password: "password1" }));
      expect(res.status).toBe(409);
    });

    test("admin disables a user, revoking their sessions", async () => {
      const adminToken = await login("root");
      const aliceToken = await login("alice");
      // Alice's token works before disabling.
      expect(auth.resolveToken(aliceToken)).not.toBeNull();

      const alice = store.getUserByUsername("alice");
      const res = await app.handle(req("PATCH", `/api/users/${alice?.id}`, adminToken, { disabled: true }));
      expect(res.status).toBe(200);
      // Session revoked + account disabled -> token no longer resolves.
      expect(auth.resolveToken(aliceToken)).toBeNull();
    });

    test("admin resets a user's password", async () => {
      const adminToken = await login("root");
      const alice = store.getUserByUsername("alice");
      const res = await app.handle(req("PATCH", `/api/users/${alice?.id}`, adminToken, { password: "newpassword1" }));
      expect(res.status).toBe(200);
      expect(await auth.login("alice", "newpassword1")).not.toBeNull();
      expect(await auth.login("alice", "pw")).toBeNull();
    });
  });

  describe("role CRUD", () => {
    test("admin creates a role with permissions", async () => {
      const adminToken = await login("root");
      const res = await app.handle(
        req("POST", "/api/roles", adminToken, {
          name: "editor",
          description: "Edits workflows",
          permissions: [PERMISSIONS.WORKFLOWS_WRITE, PERMISSIONS.WORKFLOWS_MANAGE],
        }),
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { role: { permissions: string[] } };
      expect(body.role.permissions).toContain(PERMISSIONS.WORKFLOWS_WRITE);
    });

    test("unknown permission is rejected (400)", async () => {
      const adminToken = await login("root");
      const res = await app.handle(req("POST", "/api/roles", adminToken, { name: "bogus", permissions: ["not:real"] }));
      expect(res.status).toBe(400);
    });

    test("admin replaces a custom role's permission set", async () => {
      const adminToken = await login("root");
      const editor = store.createRole("editor");
      const res = await app.handle(
        req("PUT", `/api/roles/${editor.id}/permissions`, adminToken, {
          permissions: [PERMISSIONS.MODELS_WRITE],
        }),
      );
      expect(res.status).toBe(200);
      expect(store.getRolePermissions(editor.id)).toEqual([PERMISSIONS.MODELS_WRITE]);
    });

    test("a built-in role's permission set cannot be edited (409)", async () => {
      const adminToken = await login("root");
      const userRole = store.getRoleByName(ROLE_USER);
      const res = await app.handle(
        req("PUT", `/api/roles/${userRole?.id}/permissions`, adminToken, {
          permissions: [PERMISSIONS.MODELS_WRITE],
        }),
      );
      expect(res.status).toBe(409);
    });

    test("lists roles with their permissions and the catalog", async () => {
      const adminToken = await login("root");
      const res = await app.handle(req("GET", "/api/roles", adminToken));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { roles: unknown[]; availablePermissions: string[] };
      expect(body.roles.length).toBeGreaterThan(0);
      expect(body.availablePermissions).toContain(PERMISSIONS.USERS_MANAGE);
    });
  });

  describe("user and role metadata", () => {
    test("admin sets and clears a user's display name", async () => {
      const token = await login("root");
      const alice = store.getUserByUsername("alice");
      const set = await app.handle(req("PATCH", `/api/users/${alice?.id}`, token, { displayName: "  Alice A.  " }));
      expect(set.status).toBe(200);
      expect(store.getUserById(alice?.id ?? "")?.displayName).toBe("Alice A.");

      const clear = await app.handle(req("PATCH", `/api/users/${alice?.id}`, token, { displayName: "" }));
      expect(clear.status).toBe(200);
      expect(store.getUserById(alice?.id ?? "")?.displayName).toBeUndefined();
    });

    test("role listing includes user counts", async () => {
      store.createRole("unused");
      const token = await login("root");
      const res = await app.handle(req("GET", "/api/roles", token));
      const body = (await res.json()) as { roles: { name: string; userCount: number }[] };
      expect(body.roles.find((r) => r.name === ROLE_USER)?.userCount).toBe(1);
      expect(body.roles.find((r) => r.name === "unused")?.userCount).toBe(0);
    });

    test("admin updates a custom role's description", async () => {
      const role = store.createRole("editor", "old");
      const token = await login("root");
      const res = await app.handle(req("PATCH", `/api/roles/${role.id}`, token, { description: "new" }));
      expect(res.status).toBe(200);
      expect(store.getRoleById(role.id)?.description).toBe("new");
    });

    test("a built-in role's description cannot be edited (409)", async () => {
      const userRole = store.getRoleByName(ROLE_USER);
      const token = await login("root");
      const res = await app.handle(req("PATCH", `/api/roles/${userRole?.id}`, token, { description: "x" }));
      expect(res.status).toBe(409);
    });

    test("admin deletes an unassigned custom role, removing its permissions", async () => {
      const role = store.createRole("temp");
      store.setRolePermissions(role.id, [PERMISSIONS.CHAT_WRITE]);
      const token = await login("root");
      const res = await app.handle(req("DELETE", `/api/roles/${role.id}`, token));
      expect(res.status).toBe(200);
      expect(store.getRoleById(role.id)).toBeUndefined();
      expect(store.getRolePermissions(role.id)).toEqual([]);
    });

    test("a role still assigned to users cannot be deleted (409)", async () => {
      const role = store.createRole("editor");
      const alice = store.getUserByUsername("alice");
      const userRole = store.getRoleByName(ROLE_USER);
      store.setUserRoles(alice?.id ?? "", [userRole?.id ?? "", role.id]);
      const token = await login("root");
      const res = await app.handle(req("DELETE", `/api/roles/${role.id}`, token));
      expect(res.status).toBe(409);
      expect(store.getRoleById(role.id)).toBeDefined();
    });

    test("a built-in role cannot be deleted (409)", async () => {
      const builtIn = store.createRole("fixed", undefined, true);
      const token = await login("root");
      const res = await app.handle(req("DELETE", `/api/roles/${builtIn.id}`, token));
      expect(res.status).toBe(409);
    });

    test("a non-admin cannot delete a role (403)", async () => {
      const role = store.createRole("temp");
      const token = await login("alice");
      const res = await app.handle(req("DELETE", `/api/roles/${role.id}`, token));
      expect(res.status).toBe(403);
      expect(store.getRoleById(role.id)).toBeDefined();
    });
  });

  describe("user deletion", () => {
    test("admin deletes a user, their roles, login tokens, and chat sessions", async () => {
      const aliceToken = await login("alice");
      const alice = store.getUserByUsername("alice");
      const token = await login("root");
      const res = await app.handle(req("DELETE", `/api/users/${alice?.id}`, token));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, deletedSessions: 3 });
      expect(store.getUserById(alice?.id ?? "")).toBeUndefined();
      expect(store.getUserRoleNames(alice?.id ?? "")).toEqual([]);
      expect(deletedSessionsFor).toEqual([alice?.id ?? ""]);
      // The deleted user's token no longer authenticates.
      const after = await app.handle(req("GET", "/api/users", aliceToken));
      expect(after.status).toBe(401);
    });

    test("unknown user is 404", async () => {
      const token = await login("root");
      const res = await app.handle(req("DELETE", "/api/users/nope", token));
      expect(res.status).toBe(404);
    });

    test("an admin cannot delete themselves (409)", async () => {
      await seed("root2", ROLE_ADMIN);
      const root = store.getUserByUsername("root");
      const token = await login("root");
      const res = await app.handle(req("DELETE", `/api/users/${root?.id}`, token));
      expect(res.status).toBe(409);
      expect(store.getUserById(root?.id ?? "")).toBeDefined();
    });

    test("the last enabled admin cannot be deleted by a user manager (409)", async () => {
      const managerRole = store.createRole("manager");
      store.setRolePermissions(managerRole.id, [PERMISSIONS.USERS_MANAGE]);
      const manager = store.createUser({ username: "mgr", passwordHash: await auth.hashPassword("pw") });
      store.setUserRoles(manager.id, [managerRole.id]);
      const root = store.getUserByUsername("root");
      const token = await login("mgr");
      const res = await app.handle(req("DELETE", `/api/users/${root?.id}`, token));
      expect(res.status).toBe(409);
    });

    test("the system account cannot be deleted (409)", async () => {
      const system = store.createUser({ username: "system", passwordHash: "", provider: "system" });
      const token = await login("root");
      const res = await app.handle(req("DELETE", `/api/users/${system.id}`, token));
      expect(res.status).toBe(409);
    });

    test("a user who still owns triggers cannot be deleted (409), sessions untouched", async () => {
      const alice = store.getUserByUsername("alice");
      const unregister = registerTriggerOwnerCounter("webhook", (id) => (id === alice?.id ? 2 : 0));
      try {
        const token = await login("root");
        const res = await app.handle(req("DELETE", `/api/users/${alice?.id}`, token));
        expect(res.status).toBe(409);
        expect(((await res.json()) as { error: string }).error).toContain("2 webhooks");
        expect(store.getUserById(alice?.id ?? "")).toBeDefined();
        expect(deletedSessionsFor).toEqual([]);
      } finally {
        unregister();
      }
    });

    test("a non-admin cannot delete users (403)", async () => {
      const root = store.getUserByUsername("root");
      const token = await login("alice");
      const res = await app.handle(req("DELETE", `/api/users/${root?.id}`, token));
      expect(res.status).toBe(403);
    });
  });

  describe("admin safety invariants", () => {
    /** Id of a role by name (seeded in beforeEach). */
    function roleId(name: string): string {
      return store.getRoleByName(name)?.id ?? "";
    }

    test("an admin cannot disable themselves (409)", async () => {
      const token = await login("root");
      const root = store.getUserByUsername("root");
      const res = await app.handle(req("PATCH", `/api/users/${root?.id}`, token, { disabled: true }));
      expect(res.status).toBe(409);
      expect(store.getUserById(root?.id ?? "")?.disabled).toBe(false);
    });

    test("an admin cannot remove their own admin role, even with other admins (409)", async () => {
      await seed("root2", ROLE_ADMIN);
      const token = await login("root");
      const root = store.getUserByUsername("root");
      const res = await app.handle(req("PATCH", `/api/users/${root?.id}`, token, { roleIds: [roleId(ROLE_USER)] }));
      expect(res.status).toBe(409);
      expect(store.getUserRoleNames(root?.id ?? "")).toContain(ROLE_ADMIN);
    });

    test("the last enabled admin cannot be disabled or demoted by a user manager (409)", async () => {
      await seed("mgr", "manager", [PERMISSIONS.USERS_MANAGE]);
      const token = await login("mgr");
      const root = store.getUserByUsername("root");
      const disable = await app.handle(req("PATCH", `/api/users/${root?.id}`, token, { disabled: true }));
      expect(disable.status).toBe(409);
      const demote = await app.handle(req("PATCH", `/api/users/${root?.id}`, token, { roleIds: [] }));
      expect(demote.status).toBe(409);
      expect(store.getUserRoleNames(root?.id ?? "")).toContain(ROLE_ADMIN);
    });

    test("a disabled admin does not count as a remaining admin", async () => {
      const root2Id = await seed("root2", ROLE_ADMIN);
      store.setUserDisabled(root2Id, true);
      await seed("mgr", "manager", [PERMISSIONS.USERS_MANAGE]);
      const token = await login("mgr");
      const root = store.getUserByUsername("root");
      const res = await app.handle(req("PATCH", `/api/users/${root?.id}`, token, { disabled: true }));
      expect(res.status).toBe(409);
    });

    test("admins may disable each other while another enabled admin remains", async () => {
      const root2Id = await seed("root2", ROLE_ADMIN);
      const token = await login("root");
      const res = await app.handle(req("PATCH", `/api/users/${root2Id}`, token, { disabled: true }));
      expect(res.status).toBe(200);
    });

    test("the system account cannot be modified (409)", async () => {
      const system = store.createUser({ username: "system", passwordHash: "", provider: "system" });
      const token = await login("root");
      const res = await app.handle(req("PATCH", `/api/users/${system.id}`, token, { disabled: true }));
      expect(res.status).toBe(409);
    });

    test("the system role cannot be assigned to users (409)", async () => {
      const systemRole = store.createRole("system", undefined, true);
      const token = await login("root");
      const alice = store.getUserByUsername("alice");
      const patch = await app.handle(req("PATCH", `/api/users/${alice?.id}`, token, { roleIds: [systemRole.id] }));
      expect(patch.status).toBe(409);
      const create = await app.handle(
        req("POST", "/api/users", token, { username: "eve", password: "password1", roleIds: [systemRole.id] }),
      );
      expect(create.status).toBe(409);
      expect(store.getUserByUsername("eve")).toBeUndefined();
    });
  });
});
