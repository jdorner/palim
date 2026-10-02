import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { serverOrigin } from "@src/config";
import {
  createInternalFetch,
  resolveAmbientToken,
  resolveAmbientUserId,
  runWithIdentity,
  setSystemToken,
  systemFetch,
} from "./fetch";

/** Captures the last call made to the stubbed global fetch. */
interface Captured {
  url: string;
  authorization: string | null;
}

describe("createInternalFetch", () => {
  const origin = serverOrigin();
  let captured: Captured | null;
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    captured = null;
    realFetch = globalThis.fetch;
    // Stub global fetch to capture requests without hitting the network.
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
      const headers = new Headers(init?.headers);
      captured = { url, authorization: headers.get("authorization") };
      return Promise.resolve(new Response("ok", { status: 200 }));
    }) as typeof globalThis.fetch;
    setSystemToken("");
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    setSystemToken("");
  });

  test("injects the provider token for local-origin requests", async () => {
    const f = createInternalFetch({ tokenProvider: () => "tok-123" });
    await f(`${origin}/api/chat`);
    expect(captured?.authorization).toBe("Bearer tok-123");
  });

  test("does not attach a token to external requests", async () => {
    const f = createInternalFetch({ tokenProvider: () => "tok-123" });
    await f("https://example.com/api/thing");
    expect(captured?.authorization).toBeNull();
  });

  test("omits auth when the provider yields an empty token", async () => {
    const f = createInternalFetch({ tokenProvider: () => "" });
    await f(`${origin}/api/chat`);
    expect(captured?.authorization).toBeNull();
  });

  describe("prefix confinement", () => {
    test("allows requests within the extension's own prefix", async () => {
      const f = createInternalFetch({ tokenProvider: () => "t", prefix: "/ext/telegram" });
      const res = await f(`${origin}/ext/telegram/send`);
      expect(res.status).toBe(200);
      expect(captured?.authorization).toBe("Bearer t");
    });

    test("refuses requests outside the prefix with 403 and never calls fetch", async () => {
      const f = createInternalFetch({ tokenProvider: () => "t", prefix: "/ext/telegram" });
      const res = await f(`${origin}/api/users`);
      expect(res.status).toBe(403);
      expect(captured).toBeNull(); // global fetch was never reached
    });

    test("allows the push endpoint by default even when confined", async () => {
      const f = createInternalFetch({ tokenProvider: () => "t", prefix: "/ext/telegram" });
      const res = await f(`${origin}/api/push`);
      expect(res.status).toBe(200);
    });

    test("refuses another extension's prefix", async () => {
      const f = createInternalFetch({ tokenProvider: () => "t", prefix: "/ext/telegram" });
      const res = await f(`${origin}/ext/webhooks/receive/x`);
      expect(res.status).toBe(403);
    });

    test("external requests are unaffected by confinement", async () => {
      const f = createInternalFetch({ tokenProvider: () => "t", prefix: "/ext/telegram" });
      const res = await f("https://example.com/whatever");
      expect(res.status).toBe(200);
    });
  });
});

describe("ambient identity", () => {
  afterEach(() => setSystemToken(""));

  test("resolveAmbientToken falls back to the system token when no scope is active", () => {
    setSystemToken("sys-token");
    expect(resolveAmbientToken()).toBe("sys-token");
  });

  test("resolveAmbientToken returns the scoped token inside runWithIdentity", () => {
    setSystemToken("sys-token");
    const inside = runWithIdentity("user-token", () => resolveAmbientToken());
    expect(inside).toBe("user-token");
    // Outside the scope, falls back to system again.
    expect(resolveAmbientToken()).toBe("sys-token");
  });

  test("scoped identity survives across awaits", async () => {
    setSystemToken("sys");
    const result = await runWithIdentity("scoped", async () => {
      await Promise.resolve();
      return resolveAmbientToken();
    });
    expect(result).toBe("scoped");
  });

  test("resolveAmbientUserId reports the scoped user and is undefined outside a scope", async () => {
    const inside = await runWithIdentity(
      "user-token",
      async () => {
        await Promise.resolve();
        return resolveAmbientUserId();
      },
      "user-1",
    );
    expect(inside).toBe("user-1");
    expect(resolveAmbientUserId()).toBeUndefined();
    expect(runWithIdentity("user-token", () => resolveAmbientUserId())).toBeUndefined();
  });
});

describe("systemFetch", () => {
  let captured: Captured | null;
  let realFetch: typeof globalThis.fetch;
  const origin = serverOrigin();

  beforeEach(() => {
    captured = null;
    realFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
      const headers = new Headers(init?.headers);
      captured = { url, authorization: headers.get("authorization") };
      return Promise.resolve(new Response("ok", { status: 200 }));
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    setSystemToken("");
  });

  test("carries the system token for local requests", async () => {
    setSystemToken("system-abc");
    await systemFetch(`${origin}/api/models`);
    expect(captured?.authorization).toBe("Bearer system-abc");
  });

  test("reads the current token from a provider on each request", async () => {
    let current = "first";
    setSystemToken(() => current);
    await systemFetch(`${origin}/api/models`);
    expect(captured?.authorization).toBe("Bearer first");
    current = "renewed";
    await systemFetch(`${origin}/api/models`);
    expect(captured?.authorization).toBe("Bearer renewed");
  });
});
