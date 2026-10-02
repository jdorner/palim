import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ROLE_ADMIN, ROLE_USER } from "@shared/auth";
import { AuthService, UserStore } from "@src/auth";
import { createTestDb, type TestDb } from "@src/auth/testDb";
import { serverOrigin } from "@src/config";
import { createInternalFetch, resolveAmbientToken, runWithIdentity, setSystemToken } from "@src/utils/fetch";
import { Elysia } from "elysia";
import { authCheck } from "./server";

/**
 * End-to-end confused-deputy test: an internal call made during a job bound to
 * a user's identity must authorize as that user, so a low-privilege user cannot
 * reach an admin-only endpoint even though the call originates server-side.
 */
describe("job identity propagation (confused-deputy cut #2)", () => {
  const origin = serverOrigin();
  let ctx: TestDb;
  let store: UserStore;
  let auth: AuthService;
  let app: ReturnType<typeof buildApp>;
  let realFetch: typeof globalThis.fetch;
  let adminUserId: string;
  let aliceUserId: string;

  async function seed(username: string, roleName: string): Promise<string> {
    const passwordHash = await auth.hashPassword("pw");
    const user = store.createUser({ username, passwordHash });
    const role = store.getRoleByName(roleName) ?? store.createRole(roleName, undefined, true);
    store.setUserRoles(user.id, [role.id]);
    return user.id;
  }

  /** Minimal server exposing an admin-only endpoint behind the real authCheck. */
  function buildApp() {
    return new Elysia()
      .onBeforeHandle((c) => authCheck(c as never, auth))
      .get("/api/users", ({ status }) => status(200, { ok: true }));
  }

  beforeEach(async () => {
    ctx = createTestDb();
    store = new UserStore(ctx.db);
    auth = new AuthService(store, { passwordCost: { memoryCost: 256, timeCost: 1 } });
    setSystemToken("");
    adminUserId = await seed("root", ROLE_ADMIN);
    aliceUserId = await seed("alice", ROLE_USER);

    app = buildApp();

    // Route the internal fetch's local-origin requests into the app.
    realFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
      if (url.startsWith(origin)) {
        return app.handle(new Request(url, init));
      }
      return realFetch(input, init);
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    setSystemToken("");
    ctx.sqlite.close();
  });

  /** An unconfined internal fetch bound to the ambient per-job identity. */
  const internalFetch = () => createInternalFetch({ tokenProvider: resolveAmbientToken });

  test("a user-initiated internal call to /api/users is denied (403)", async () => {
    const minted = auth.mintInternalToken(aliceUserId);
    const status = await runWithIdentity(minted?.token ?? "", async () => {
      const res = await internalFetch()(`${origin}/api/users`);
      return res.status;
    });
    expect(status).toBe(403);
  });

  test("an admin-initiated internal call to /api/users is allowed (200)", async () => {
    const minted = auth.mintInternalToken(adminUserId);
    const status = await runWithIdentity(minted?.token ?? "", async () => {
      const res = await internalFetch()(`${origin}/api/users`);
      return res.status;
    });
    expect(status).toBe(200);
  });

  test("with no ambient identity and no system token, the call is unauthorized (401)", async () => {
    const res = await internalFetch()(`${origin}/api/users`);
    expect(res.status).toBe(401);
  });

  test("the ambient identity resolves to the initiating user during the job", async () => {
    const minted = auth.mintInternalToken(aliceUserId);
    const seenUserId = await runWithIdentity(minted?.token ?? "", async () => {
      const principal = auth.resolveToken(resolveAmbientToken());
      return principal?.user.id;
    });
    expect(seenUserId).toBe(aliceUserId);
  });
});
