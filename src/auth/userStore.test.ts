import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PERMISSIONS } from "@shared/auth";
import { createTestDb, type TestDb } from "./testDb";
import { UserStore } from "./userStore";

describe("UserStore", () => {
  let ctx: TestDb;
  let store: UserStore;

  beforeEach(() => {
    ctx = createTestDb();
    store = new UserStore(ctx.db);
  });

  afterEach(() => {
    ctx.sqlite.close();
  });

  describe("users", () => {
    test("creates and retrieves a user without exposing the hash in listings", () => {
      const created = store.createUser({ username: "alice", passwordHash: "hash-a", displayName: "Alice" });
      expect(created.username).toBe("alice");
      expect(created.disabled).toBe(false);

      const byId = store.getUserById(created.id);
      expect(byId?.username).toBe("alice");
      expect(byId?.displayName).toBe("Alice");
      // UserRecord has no passwordHash field
      expect((byId as unknown as Record<string, unknown>).passwordHash).toBeUndefined();

      const listed = store.listUsers();
      expect(listed.length).toBe(1);
      expect((listed[0] as unknown as Record<string, unknown>).passwordHash).toBeUndefined();
    });

    test("getUserByUsername returns the password hash for verification", () => {
      store.createUser({ username: "bob", passwordHash: "hash-b" });
      const withSecret = store.getUserByUsername("bob");
      expect(withSecret?.passwordHash).toBe("hash-b");
    });

    test("rejects duplicate usernames", () => {
      store.createUser({ username: "carol", passwordHash: "h" });
      expect(() => store.createUser({ username: "carol", passwordHash: "h2" })).toThrow();
    });

    test("countUsers reflects inserts", () => {
      expect(store.countUsers()).toBe(0);
      store.createUser({ username: "d", passwordHash: "h" });
      store.createUser({ username: "e", passwordHash: "h" });
      expect(store.countUsers()).toBe(2);
    });

    test("disable and password reset update the record", () => {
      const u = store.createUser({ username: "f", passwordHash: "old" });
      store.setUserDisabled(u.id, true);
      expect(store.getUserById(u.id)?.disabled).toBe(true);

      store.setPasswordHash(u.id, "new");
      expect(store.getUserByUsername("f")?.passwordHash).toBe("new");
    });
  });

  describe("user deletion", () => {
    test("deleteUser removes the user, their role assignments, and login sessions", () => {
      const user = store.createUser({ username: "u", passwordHash: "h" });
      const role = store.createRole("r");
      store.setUserRoles(user.id, [role.id]);
      store.insertSession({ userId: user.id, tokenHash: "th", expiresAt: Date.now() + 60_000 });

      store.deleteUser(user.id);

      expect(store.getUserById(user.id)).toBeUndefined();
      expect(store.getUserRoleNames(user.id)).toEqual([]);
      expect(store.findSessionByTokenHash("th")).toBeUndefined();
      expect(store.getRoleById(role.id)).toBeDefined();
    });
  });

  describe("roles and permissions", () => {
    test("creates roles and resolves their permissions", () => {
      const role = store.createRole("editor", "Can edit workflows", false);
      store.setRolePermissions(role.id, [PERMISSIONS.WORKFLOWS_WRITE, PERMISSIONS.WORKFLOWS_MANAGE]);

      const perms = store.getRolePermissions(role.id);
      expect(perms).toContain(PERMISSIONS.WORKFLOWS_MANAGE);
      expect(perms).toContain(PERMISSIONS.WORKFLOWS_WRITE);
      expect(perms.length).toBe(2);
    });

    test("setRolePermissions replaces the prior set", () => {
      const role = store.createRole("r", undefined, false);
      store.setRolePermissions(role.id, [PERMISSIONS.CHAT_WRITE]);
      store.setRolePermissions(role.id, [PERMISSIONS.MODELS_WRITE]);
      const perms = store.getRolePermissions(role.id);
      expect(perms).toEqual([PERMISSIONS.MODELS_WRITE]);
    });

    test("getRoleByName finds a role", () => {
      store.createRole("admin", "Superuser", true);
      const found = store.getRoleByName("admin");
      expect(found?.builtIn).toBe(true);
    });

    test("setRoleDescription updates and clears the description", () => {
      const role = store.createRole("r", "old");
      store.setRoleDescription(role.id, "new");
      expect(store.getRoleById(role.id)?.description).toBe("new");
      store.setRoleDescription(role.id, null);
      expect(store.getRoleById(role.id)?.description).toBeUndefined();
    });

    test("deleteRole removes the role, its permissions, and its assignments", () => {
      const role = store.createRole("r");
      const user = store.createUser({ username: "u", passwordHash: "h" });
      store.setRolePermissions(role.id, [PERMISSIONS.CHAT_WRITE]);
      store.setUserRoles(user.id, [role.id]);

      store.deleteRole(role.id);

      expect(store.getRoleById(role.id)).toBeUndefined();
      expect(store.getRolePermissions(role.id)).toEqual([]);
      expect(store.getUserRoleNames(user.id)).toEqual([]);
    });

    test("countUsersByRole counts assignments per role", () => {
      const a = store.createRole("a");
      const b = store.createRole("b");
      const u1 = store.createUser({ username: "u1", passwordHash: "h" });
      const u2 = store.createUser({ username: "u2", passwordHash: "h" });
      store.setUserRoles(u1.id, [a.id, b.id]);
      store.setUserRoles(u2.id, [a.id]);

      const counts = store.countUsersByRole();
      expect(counts.get(a.id)).toBe(2);
      expect(counts.get(b.id)).toBe(1);
    });

    test("countUsersByRole ignores assignments of users that no longer exist", () => {
      const a = store.createRole("a");
      store.setUserRoles("ghost-user-id", [a.id]);
      expect(store.countUsersByRole().get(a.id)).toBeUndefined();
    });
  });

  describe("user-role assignment and effective permissions", () => {
    test("unions permissions across assigned roles and deduplicates", () => {
      const user = store.createUser({ username: "g", passwordHash: "h" });
      const roleA = store.createRole("a", undefined, false);
      const roleB = store.createRole("b", undefined, false);
      store.setRolePermissions(roleA.id, [PERMISSIONS.CHAT_WRITE, PERMISSIONS.JOBS_WRITE]);
      store.setRolePermissions(roleB.id, [PERMISSIONS.CHAT_WRITE, PERMISSIONS.WORKFLOWS_WRITE]);

      store.setUserRoles(user.id, [roleA.id, roleB.id]);

      expect(store.getUserRoleNames(user.id).sort()).toEqual(["a", "b"]);

      const effective = store.getEffectivePermissions(user.id).sort();
      expect(effective).toEqual([PERMISSIONS.CHAT_WRITE, PERMISSIONS.JOBS_WRITE, PERMISSIONS.WORKFLOWS_WRITE].sort());
    });

    test("setUserRoles replaces the prior assignment", () => {
      const user = store.createUser({ username: "h", passwordHash: "h" });
      const roleA = store.createRole("x", undefined, false);
      const roleB = store.createRole("y", undefined, false);
      store.setUserRoles(user.id, [roleA.id]);
      store.setUserRoles(user.id, [roleB.id]);
      expect(store.getUserRoleNames(user.id)).toEqual(["y"]);
    });

    test("a user with no roles has no permissions", () => {
      const user = store.createUser({ username: "i", passwordHash: "h" });
      expect(store.getEffectivePermissions(user.id)).toEqual([]);
    });
  });

  describe("session tokens", () => {
    test("insert, find, touch, and delete a session", () => {
      const user = store.createUser({ username: "j", passwordHash: "h" });
      const expiresAt = Date.now() + 60_000;
      const session = store.insertSession({ userId: user.id, tokenHash: "th-1", expiresAt });

      const found = store.findSessionByTokenHash("th-1");
      expect(found?.userId).toBe(user.id);
      expect(found?.id).toBe(session.id);

      store.touchSession(session.id, Date.now() + 1);
      expect(store.findSessionByTokenHash("th-1")).not.toBeUndefined();

      expect(store.deleteSessionByTokenHash("th-1")).toBe(true);
      expect(store.findSessionByTokenHash("th-1")).toBeUndefined();
      expect(store.deleteSessionByTokenHash("th-1")).toBe(false);
    });

    test("deleteSessionsForUser removes all of a user's tokens", () => {
      const user = store.createUser({ username: "k", passwordHash: "h" });
      const exp = Date.now() + 60_000;
      store.insertSession({ userId: user.id, tokenHash: "t1", expiresAt: exp });
      store.insertSession({ userId: user.id, tokenHash: "t2", expiresAt: exp });
      store.deleteSessionsForUser(user.id);
      expect(store.findSessionByTokenHash("t1")).toBeUndefined();
      expect(store.findSessionByTokenHash("t2")).toBeUndefined();
    });

    test("deleteExpiredSessions removes only expired rows", () => {
      const user = store.createUser({ username: "l", passwordHash: "h" });
      const now = Date.now();
      store.insertSession({ userId: user.id, tokenHash: "fresh", expiresAt: now + 60_000 });
      store.insertSession({ userId: user.id, tokenHash: "stale", expiresAt: now - 1 });

      const deleted = store.deleteExpiredSessions(now);
      expect(deleted).toBe(1);
      expect(store.findSessionByTokenHash("fresh")).not.toBeUndefined();
      expect(store.findSessionByTokenHash("stale")).toBeUndefined();
    });

    test("rejects duplicate token hashes", () => {
      const user = store.createUser({ username: "m", passwordHash: "h" });
      const exp = Date.now() + 60_000;
      store.insertSession({ userId: user.id, tokenHash: "dup", expiresAt: exp });
      expect(() => store.insertSession({ userId: user.id, tokenHash: "dup", expiresAt: exp })).toThrow();
    });
  });
});
