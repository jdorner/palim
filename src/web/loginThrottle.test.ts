import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AuthService, UserStore } from "@src/auth";
import { createTestDb, type TestDb } from "@src/auth/testDb";
import { Elysia } from "elysia";
import { LoginThrottle } from "./loginThrottle";
import { authRoutes } from "./routes/auth";

/** Builds a throttle on a controllable clock. */
function throttleAt(opts: { freeFailures?: number; maxEntries?: number } = {}) {
  const clock = { t: 1_000_000 };
  const throttle = new LoginThrottle({
    freeFailures: opts.freeFailures ?? 2,
    baseDelayMs: 1_000,
    maxDelayMs: 8_000,
    forgetAfterMs: 60_000,
    maxEntries: opts.maxEntries,
    now: () => clock.t,
  });
  return { throttle, clock };
}

describe("LoginThrottle", () => {
  test("allows the free failures, then locks with doubling delays up to the cap", () => {
    const { throttle } = throttleAt();
    throttle.recordFailure("1.1.1.1", "alice");
    throttle.recordFailure("1.1.1.1", "alice");
    expect(throttle.retryAfterMs("1.1.1.1", "alice")).toBe(0);

    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      throttle.recordFailure("1.1.1.1", "alice");
      delays.push(throttle.retryAfterMs("1.1.1.1", "alice"));
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 8_000]);
  });

  test("lockout expires with time", () => {
    const { throttle, clock } = throttleAt({ freeFailures: 0 });
    throttle.recordFailure("1.1.1.1", "alice");
    expect(throttle.retryAfterMs("1.1.1.1", "alice")).toBe(1_000);
    clock.t += 1_000;
    expect(throttle.retryAfterMs("1.1.1.1", "alice")).toBe(0);
  });

  test("locks a username targeted from many IPs", () => {
    const { throttle } = throttleAt();
    for (let i = 0; i < 3; i++) throttle.recordFailure(`10.0.0.${i}`, "Alice");
    expect(throttle.retryAfterMs("10.0.0.99", "alice")).toBeGreaterThan(0);
    expect(throttle.retryAfterMs("10.0.0.99", "bob")).toBe(0);
  });

  test("locks an IP spraying many usernames", () => {
    const { throttle } = throttleAt();
    for (const name of ["a", "b", "c"]) throttle.recordFailure("1.1.1.1", name);
    expect(throttle.retryAfterMs("1.1.1.1", "d")).toBeGreaterThan(0);
    expect(throttle.retryAfterMs("2.2.2.2", "d")).toBe(0);
  });

  test("success clears the counters", () => {
    const { throttle } = throttleAt();
    for (let i = 0; i < 3; i++) throttle.recordFailure("1.1.1.1", "alice");
    throttle.recordSuccess("1.1.1.1", "alice");
    expect(throttle.retryAfterMs("1.1.1.1", "alice")).toBe(0);
    throttle.recordFailure("1.1.1.1", "alice");
    expect(throttle.retryAfterMs("1.1.1.1", "alice")).toBe(0);
  });

  test("forgets failures after the idle window", () => {
    const { throttle, clock } = throttleAt();
    throttle.recordFailure("1.1.1.1", "alice");
    throttle.recordFailure("1.1.1.1", "alice");
    clock.t += 60_001;
    throttle.recordFailure("1.1.1.1", "alice");
    expect(throttle.retryAfterMs("1.1.1.1", "alice")).toBe(0);
  });

  test("evicts the oldest entries beyond the size cap", () => {
    const { throttle } = throttleAt({ freeFailures: 0, maxEntries: 4 });
    throttle.recordFailure("1.1.1.1", "alice");
    throttle.recordFailure("2.2.2.2", "bob");
    throttle.recordFailure("3.3.3.3", "carol");
    // alice's and her IP's entries were evicted to make room.
    expect(throttle.retryAfterMs("1.1.1.1", "alice")).toBe(0);
    expect(throttle.retryAfterMs("3.3.3.3", "carol")).toBeGreaterThan(0);
  });
});

describe("POST /api/auth/login with a throttle", () => {
  let ctx: TestDb;
  let app: Elysia;

  beforeEach(async () => {
    ctx = createTestDb();
    const store = new UserStore(ctx.db);
    const auth = new AuthService(store, { passwordCost: { memoryCost: 256, timeCost: 1 } });
    store.createUser({ username: "alice", passwordHash: await auth.hashPassword("alicepw") });
    app = new Elysia().use(authRoutes(() => auth, undefined, new LoginThrottle({ freeFailures: 2 }))) as never;
  });

  afterEach(() => ctx.sqlite.close());

  const attempt = (password: string) =>
    app.handle(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "alice", password }),
      }),
    );

  test("returns 429 with Retry-After once locked, even for the right password", async () => {
    expect((await attempt("wrong")).status).toBe(401);
    expect((await attempt("wrong")).status).toBe(401);
    expect((await attempt("wrong")).status).toBe(401);

    const locked = await attempt("alicepw");
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("a successful login before lockout resets the count", async () => {
    expect((await attempt("wrong")).status).toBe(401);
    expect((await attempt("wrong")).status).toBe(401);
    expect((await attempt("alicepw")).status).toBe(200);
    expect((await attempt("wrong")).status).toBe(401);
    expect((await attempt("wrong")).status).toBe(401);
    expect((await attempt("wrong")).status).toBe(401);
  });
});
