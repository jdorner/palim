import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ROLE_ADMIN, ROLE_USER } from "@shared/auth";
import { AuthService, UserStore } from "@src/auth";
import { createTestDb, type TestDb } from "@src/auth/testDb";
import { resetAdmin } from "./resetAdmin";

describe("resetAdmin", () => {
  let ctx: TestDb;
  let store: UserStore;
  let auth: AuthService;

  beforeEach(() => {
    ctx = createTestDb();
    store = new UserStore(ctx.db);
    auth = new AuthService(store, { passwordCost: { memoryCost: 256, timeCost: 1 } });
    store.createRole(ROLE_ADMIN, undefined, true);
    store.createRole(ROLE_USER, undefined, true);
  });

  afterEach(() => {
    ctx.sqlite.close();
  });

  test("re-enables a user, adds the admin role, keeps other roles, and sets a new password", async () => {
    const user = store.createUser({ username: "root", passwordHash: await auth.hashPassword("old-password") });
    store.setUserRoles(user.id, [store.getRoleByName(ROLE_USER)?.id ?? ""]);
    store.setUserDisabled(user.id, true);

    const result = await resetAdmin(store, auth, "root");

    expect(result.created).toBe(false);
    expect(store.getUserById(user.id)?.disabled).toBe(false);
    expect(store.getUserRoleNames(user.id).sort()).toEqual([ROLE_ADMIN, ROLE_USER]);
    expect(await auth.login("root", result.password)).not.toBeNull();
    expect(await auth.login("root", "old-password")).toBeNull();
  });

  test("creates the user when missing", async () => {
    const result = await resetAdmin(store, auth, "newadmin");
    expect(result.created).toBe(true);
    const user = store.getUserByUsername("newadmin");
    expect(store.getUserRoleNames(user?.id ?? "")).toEqual([ROLE_ADMIN]);
  });

  test("refuses the system account", async () => {
    await expect(resetAdmin(store, auth, "system")).rejects.toThrow();
  });
});
