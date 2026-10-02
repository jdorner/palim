import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PERMISSIONS, ROLE_ADMIN, ROLE_USER } from "@shared/auth";
import { ownedSubject } from "./ability";
import { AuthService, hashToken, serializeAbility } from "./authService";
import { createTestDb, type TestDb } from "./testDb";
import { UserStore } from "./userStore";

/**
 * Seeds a user with a hashed password and the given role names, creating roles
 * (and their permissions) as needed.
 */
async function seedUser(
  auth: AuthService,
  store: UserStore,
  username: string,
  password: string,
  roleSpecs: { name: string; permissions?: readonly string[] }[],
): Promise<string> {
  const passwordHash = await auth.hashPassword(password);
  const user = store.createUser({ username, passwordHash });
  const roleIds: string[] = [];
  for (const spec of roleSpecs) {
    const existing = store.getRoleByName(spec.name);
    const role = existing ?? store.createRole(spec.name, undefined, true);
    if (spec.permissions) {
      store.setRolePermissions(role.id, spec.permissions as never);
    }
    roleIds.push(role.id);
  }
  store.setUserRoles(user.id, roleIds);
  return user.id;
}

describe("AuthService", () => {
  let ctx: TestDb;
  let store: UserStore;
  let auth: AuthService;

  // Low argon2id cost keeps the suite fast without weakening production hashing.
  const TEST_COST = { memoryCost: 256, timeCost: 1 };

  beforeEach(() => {
    ctx = createTestDb();
    store = new UserStore(ctx.db);
    auth = new AuthService(store, { sessionTtlMs: 60_000, passwordCost: TEST_COST });
  });

  afterEach(() => {
    ctx.sqlite.close();
  });

  describe("password hashing", () => {
    test("hash then verify round-trips", async () => {
      const hash = await auth.hashPassword("s3cret");
      expect(await AuthService.verifyPassword("s3cret", hash)).toBe(true);
      expect(await AuthService.verifyPassword("wrong", hash)).toBe(false);
    });

    test("verify against empty or malformed hash is false", async () => {
      expect(await AuthService.verifyPassword("x", "")).toBe(false);
      expect(await AuthService.verifyPassword("x", "not-a-hash")).toBe(false);
    });
  });

  describe("login", () => {
    test("issues a resolvable token for correct credentials", async () => {
      await seedUser(auth, store, "alice", "pw-alice", [{ name: ROLE_USER, permissions: [PERMISSIONS.CHAT_WRITE] }]);

      const result = await auth.login("alice", "pw-alice");
      expect(result).not.toBeNull();
      expect(result?.token.length).toBeGreaterThan(0);
      expect(result?.principal.user.username).toBe("alice");
      expect(result?.principal.isAdmin).toBe(false);

      const resolved = auth.resolveToken(result?.token ?? "");
      expect(resolved?.user.username).toBe("alice");
    });

    test("fails for a wrong password", async () => {
      await seedUser(auth, store, "bob", "pw-bob", [{ name: ROLE_USER }]);
      expect(await auth.login("bob", "nope")).toBeNull();
    });

    test("fails for an unknown user", async () => {
      expect(await auth.login("ghost", "x")).toBeNull();
    });

    test("fails for a disabled user", async () => {
      const id = await seedUser(auth, store, "carol", "pw", [{ name: ROLE_USER }]);
      store.setUserDisabled(id, true);
      expect(await auth.login("carol", "pw")).toBeNull();
    });
  });

  describe("resolveToken", () => {
    test("returns null for an unknown token", () => {
      expect(auth.resolveToken("bogus")).toBeNull();
      expect(auth.resolveToken("")).toBeNull();
    });

    test("returns null and cleans up an expired token", async () => {
      const shortAuth = new AuthService(store, { sessionTtlMs: -1 });
      await seedUser(auth, store, "dave", "pw", [{ name: ROLE_USER }]);
      const result = await shortAuth.login("dave", "pw");
      expect(result).not.toBeNull();
      // TTL was negative, so the token is already expired.
      expect(shortAuth.resolveToken(result?.token ?? "")).toBeNull();
      // The expired row was removed.
      expect(store.findSessionByTokenHash(hashToken(result?.token ?? ""))).toBeUndefined();
    });

    test("admin resolves with superuser ability", async () => {
      await seedUser(auth, store, "root", "pw-root", [{ name: ROLE_ADMIN }]);
      const result = await auth.login("root", "pw-root");
      const resolved = auth.resolveToken(result?.token ?? "");
      expect(resolved?.isAdmin).toBe(true);
      expect(resolved?.ability.can("manage", "all")).toBe(true);
    });

    test("standard user's ability is scoped to owned sessions", async () => {
      const userId = await seedUser(auth, store, "erin", "pw", [
        { name: ROLE_USER, permissions: [PERMISSIONS.CHAT_WRITE] },
      ]);
      const result = await auth.login("erin", "pw");
      const resolved = auth.resolveToken(result?.token ?? "");
      expect(resolved).not.toBeNull();
      const own = ownedSubject("Session", { userId });
      const other = ownedSubject("Session", { userId: "someone-else" });
      expect(resolved?.ability.can("read", own)).toBe(true);
      expect(resolved?.ability.can("read", other)).toBe(false);
      expect(resolved?.ability.can("manage", "User")).toBe(false);
    });
  });

  describe("logout", () => {
    test("invalidates the token", async () => {
      await seedUser(auth, store, "frank", "pw", [{ name: ROLE_USER }]);
      const result = await auth.login("frank", "pw");
      const token = result?.token ?? "";
      expect(auth.resolveToken(token)).not.toBeNull();
      expect(auth.logout(token)).toBe(true);
      expect(auth.resolveToken(token)).toBeNull();
      expect(auth.logout(token)).toBe(false);
    });
  });

  describe("mintInternalToken", () => {
    test("mints a token that resolves to the bound user", async () => {
      const userId = await seedUser(auth, store, "grace", "pw", [
        { name: ROLE_USER, permissions: [PERMISSIONS.CHAT_WRITE] },
      ]);
      const minted = auth.mintInternalToken(userId);
      expect(minted).not.toBeNull();
      const resolved = auth.resolveToken(minted?.token ?? "");
      expect(resolved?.user.id).toBe(userId);
    });

    test("returns null for an unknown user", () => {
      expect(auth.mintInternalToken("nope")).toBeNull();
    });

    test("returns null for a disabled user", async () => {
      const userId = await seedUser(auth, store, "heidi", "pw", [{ name: ROLE_USER }]);
      store.setUserDisabled(userId, true);
      expect(auth.mintInternalToken(userId)).toBeNull();
    });

    test("reuses a cached token instead of inserting a new session row", async () => {
      const userId = await seedUser(auth, store, "ivan", "pw", [{ name: ROLE_USER }]);
      const first = auth.mintInternalToken(userId);
      const second = auth.mintInternalToken(userId);
      expect(second?.token).toBe(first?.token ?? "");
      const rows = ctx.sqlite.query("SELECT COUNT(*) AS n FROM user_sessions WHERE user_id = ?").get(userId) as {
        n: number;
      };
      expect(rows.n).toBe(1);
    });

    test("mints a fresh token when the cached one was revoked", async () => {
      const userId = await seedUser(auth, store, "judy", "pw", [{ name: ROLE_USER }]);
      const first = auth.mintInternalToken(userId);
      auth.logout(first?.token ?? "");
      const second = auth.mintInternalToken(userId);
      expect(second?.token).not.toBe(first?.token ?? "");
      expect(auth.resolveToken(second?.token ?? "")?.user.id).toBe(userId);
    });
  });

  describe("purgeExpiredSessions", () => {
    test("removes expired tokens and keeps valid ones", async () => {
      const userId = await seedUser(auth, store, "ken", "pw", [{ name: ROLE_USER }]);
      store.insertSession({ userId, tokenHash: hashToken("old"), expiresAt: Date.now() - 1 });
      const live = auth.mintInternalToken(userId);
      expect(auth.purgeExpiredSessions()).toBe(1);
      expect(auth.resolveToken(live?.token ?? "")).not.toBeNull();
    });
  });

  describe("serializeAbility", () => {
    test("produces the payload the frontend rebuilds from", async () => {
      const userId = await seedUser(auth, store, "ivan", "pw", [
        { name: ROLE_USER, permissions: [PERMISSIONS.CHAT_WRITE] },
      ]);
      const result = await auth.login("ivan", "pw");
      const serialized = serializeAbility(result?.principal ?? ({} as never));
      expect(serialized.userId).toBe(userId);
      expect(serialized.isAdmin).toBe(false);
      expect(serialized.permissions).toContain(PERMISSIONS.CHAT_WRITE);
    });
  });
});
