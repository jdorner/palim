import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BUILT_IN_ROLES, PERMISSIONS, ROLE_ADMIN, ROLE_SYSTEM, ROLE_USER } from "@shared/auth";
import { sessions } from "@src/db/schema";
import { fileWatchers } from "@src/extensions/core/filewatcher/schema";
import { webhooks } from "@src/extensions/core/webhooks/schema";
import { eq } from "drizzle-orm";
import { AuthService } from "./authService";
import { seedAuth } from "./seed";
import { createTestDb, type TestDb } from "./testDb";
import { UserStore } from "./userStore";

describe("seedAuth", () => {
  let ctx: TestDb;
  let store: UserStore;
  let auth: AuthService;

  beforeEach(() => {
    ctx = createTestDb();
    store = new UserStore(ctx.db);
    auth = new AuthService(store, { passwordCost: { memoryCost: 256, timeCost: 1 } });
  });

  afterEach(() => {
    ctx.sqlite.close();
  });

  /** Inserts a raw ownerless session row. */
  function insertOrphanSession(id: string): void {
    const now = Date.now();
    ctx.sqlite.run(
      "INSERT INTO sessions (id, source, source_id, user_id, created_at, updated_at) VALUES (?, 'chat', ?, NULL, ?, ?)",
      [id, id, now, now],
    );
  }

  test("first boot creates the admin, built-in roles, and a one-time password", async () => {
    const result = await seedAuth({
      userStore: store,
      authService: auth,
      db: ctx.db,
      adminUsername: "admin",
      adminPassword: "",
    });

    expect(result.createdAdmin).toBe(true);
    expect(result.generatedPassword).toBeDefined();
    expect((result.generatedPassword ?? "").length).toBeGreaterThan(0);

    // Admin exists with the admin role.
    const admin = store.getUserByUsername("admin");
    expect(admin).not.toBeUndefined();
    expect(store.getUserRoleNames(admin?.id ?? "")).toContain(ROLE_ADMIN);

    // All three built-in roles exist.
    expect(store.getRoleByName(ROLE_ADMIN)?.builtIn).toBe(true);
    expect(store.getRoleByName(ROLE_USER)).not.toBeUndefined();
    expect(store.getRoleByName(ROLE_SYSTEM)).not.toBeUndefined();

    // The user role has the expected scoped permissions; system lacks users:manage.
    const userRoleId = store.getRoleByName(ROLE_USER)?.id ?? "";
    expect(store.getRolePermissions(userRoleId)).toContain(PERMISSIONS.CHAT_WRITE);
    const systemRoleId = store.getRoleByName(ROLE_SYSTEM)?.id ?? "";
    expect(store.getRolePermissions(systemRoleId)).not.toContain(PERMISSIONS.USERS_MANAGE);
  });

  test("the generated admin password actually works for login", async () => {
    const result = await seedAuth({
      userStore: store,
      authService: auth,
      db: ctx.db,
      adminUsername: "admin",
      adminPassword: "",
    });
    const login = await auth.login("admin", result.generatedPassword ?? "");
    expect(login).not.toBeNull();
    expect(login?.principal.isAdmin).toBe(true);
  });

  test("uses the configured password when provided (no generated password)", async () => {
    const result = await seedAuth({
      userStore: store,
      authService: auth,
      db: ctx.db,
      adminUsername: "root",
      adminPassword: "hunter2",
    });
    expect(result.generatedPassword).toBeUndefined();
    const login = await auth.login("root", "hunter2");
    expect(login).not.toBeNull();
  });

  test("claims pre-existing ownerless sessions for the admin", async () => {
    insertOrphanSession("s1");
    insertOrphanSession("s2");

    const result = await seedAuth({
      userStore: store,
      authService: auth,
      db: ctx.db,
      adminUsername: "admin",
      adminPassword: "pw",
    });

    expect(result.claimedSessions).toBe(2);
    const row = ctx.db.select().from(sessions).where(eq(sessions.id, "s1")).get();
    expect(row?.userId).toBe(result.adminUserId);
  });

  test("claims pre-existing ownerless triggers for the admin", async () => {
    const now = Date.now();
    ctx.sqlite.run(
      "INSERT INTO ext_filewatcher_watchers (slug, name, path, patterns, events, recursive, process_existing, enabled, created_at, created_by_user_id) VALUES ('w1', 'W', 'inbox', '[]', '[\"new\"]', 0, 0, 1, ?, NULL)",
      [now],
    );
    ctx.sqlite.run(
      "INSERT INTO ext_webhooks_registrations (slug, name, auth_type, secret, header_name, enabled, created_at, created_by_user_id) VALUES ('h1', 'H', 'none', '', '', 1, ?, NULL)",
      [now],
    );

    const result = await seedAuth({
      userStore: store,
      authService: auth,
      db: ctx.db,
      adminUsername: "admin",
      adminPassword: "pw",
    });

    expect(result.claimedTriggers).toBe(2);
    const watcher = ctx.db.select().from(fileWatchers).where(eq(fileWatchers.slug, "w1")).get();
    expect(watcher?.createdByUserId).toBe(result.adminUserId);
    const hook = ctx.db.select().from(webhooks).where(eq(webhooks.slug, "h1")).get();
    expect(hook?.createdByUserId).toBe(result.adminUserId);
  });

  test("is idempotent: second run creates nothing new", async () => {
    await seedAuth({
      userStore: store,
      authService: auth,
      db: ctx.db,
      adminUsername: "admin",
      adminPassword: "pw",
    });
    const before = store.countUsers();

    const second = await seedAuth({
      userStore: store,
      authService: auth,
      db: ctx.db,
      adminUsername: "admin",
      adminPassword: "pw",
    });

    expect(second.createdAdmin).toBe(false);
    expect(store.countUsers()).toBe(before);
    expect(second.claimedSessions).toBe(0);
  });

  test("resyncs stale built-in role descriptions from the catalog", async () => {
    const stale = store.createRole(ROLE_USER, "outdated text", true);

    await seedAuth({
      userStore: store,
      authService: auth,
      db: ctx.db,
      adminUsername: "admin",
      adminPassword: "pw",
    });

    expect(store.getRoleByName(ROLE_USER)?.description).toBe(BUILT_IN_ROLES[ROLE_USER]?.description);
    expect(store.getRoleByName(ROLE_USER)?.id).toBe(stale.id);
  });

  test("ensures a non-login system user with the system role", async () => {
    const result = await seedAuth({
      userStore: store,
      authService: auth,
      db: ctx.db,
      adminUsername: "admin",
      adminPassword: "pw",
    });
    expect(result.systemUserId.length).toBeGreaterThan(0);
    const systemUser = store.getUserByUsername("system");
    expect(systemUser).not.toBeUndefined();
    expect(systemUser?.provider).toBe("system");
    // Empty password hash never verifies -> cannot log in.
    expect(await auth.login("system", "")).toBeNull();
    expect(store.getUserRoleNames(result.systemUserId)).toContain(ROLE_SYSTEM);
    // A system internal token can be minted and resolves to the system user.
    const minted = auth.mintInternalToken(result.systemUserId);
    expect(minted).not.toBeNull();
    expect(auth.resolveToken(minted?.token ?? "")?.user.id).toBe(result.systemUserId);
  });

  test("system user is not created twice across runs", async () => {
    await seedAuth({ userStore: store, authService: auth, db: ctx.db, adminUsername: "admin", adminPassword: "pw" });
    const first = store.getUserByUsername("system")?.id;
    await seedAuth({ userStore: store, authService: auth, db: ctx.db, adminUsername: "admin", adminPassword: "pw" });
    const second = store.getUserByUsername("system")?.id;
    expect(second).toBe(first);
  });

  test("does not seed a second admin when users already exist", async () => {
    // Pre-create a non-admin user so the table is non-empty.
    store.createUser({ username: "someone", passwordHash: "x" });

    const result = await seedAuth({
      userStore: store,
      authService: auth,
      db: ctx.db,
      adminUsername: "admin",
      adminPassword: "pw",
    });

    expect(result.createdAdmin).toBe(false);
    expect(store.getUserByUsername("admin")).toBeUndefined();
  });
});
