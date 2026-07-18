import { beforeEach, describe, expect, test } from "bun:test";
import { buildPushCommand } from "./sandbox";

/**
 * Builds a minimal CommandContext stub suitable for testing buildPushCommand.
 * The push command accesses ctx.env via Map.get(), so we provide an actual Map.
 */
function makeCtx(env: Record<string, string> = {}) {
  return {
    env: new Map(Object.entries(env)),
    stdin: new Uint8Array(0) as unknown,
    cwd: "/home/user/work",
    fs: {} as unknown,
  } as Parameters<ReturnType<typeof buildPushCommand>>[1];
}

describe("buildPushCommand", () => {
  let handler: ReturnType<typeof buildPushCommand>;
  let fetchCalls: Array<{ url: string; init: RequestInit }>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    handler = buildPushCommand();
    fetchCalls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), init: init ?? {} });
      return new Response(null, { status: 202 });
    }) as typeof globalThis.fetch;
  });

  // Restore fetch after each test to avoid side effects
  const restoreFetch = () => {
    globalThis.fetch = originalFetch;
  };

  describe("valid content argument", () => {
    test("sends correct JSON payload with default contentType", async () => {
      const ctx = makeCtx({
        PALIM_PUSH_URL: "http://localhost:3000/api/push",
        PALIM_SESSION_ID: "session-abc",
      });

      const result = await handler(["Hello from the script"], ctx);
      restoreFetch();

      expect(result.exitCode).toBe(0);
      expect(fetchCalls).toHaveLength(1);

      const call = fetchCalls[0]!;
      expect(call.url).toBe("http://localhost:3000/api/push");
      expect(call.init.method).toBe("POST");

      const body = JSON.parse(call.init.body as string);
      expect(body).toEqual({
        sessionId: "session-abc",
        content: "Hello from the script",
        contentType: "text/markdown",
      });
    });
  });

  describe("--type flag", () => {
    test("sets contentType to text/plain in payload", async () => {
      const ctx = makeCtx({
        PALIM_PUSH_URL: "http://localhost:3000/api/push",
        PALIM_SESSION_ID: "session-xyz",
      });

      const result = await handler(["--type", "text/plain", "Raw output"], ctx);
      restoreFetch();

      expect(result.exitCode).toBe(0);
      expect(fetchCalls).toHaveLength(1);

      const body = JSON.parse(fetchCalls[0]!.init.body as string);
      expect(body.contentType).toBe("text/plain");
      expect(body.content).toBe("Raw output");
    });

    test("-t short flag also sets contentType", async () => {
      const ctx = makeCtx({
        PALIM_PUSH_URL: "http://localhost:3000/api/push",
        PALIM_SESSION_ID: "session-xyz",
      });

      const result = await handler(["-t", "text/plain", "Short flag"], ctx);
      restoreFetch();

      expect(result.exitCode).toBe(0);
      const body = JSON.parse(fetchCalls[0]!.init.body as string);
      expect(body.contentType).toBe("text/plain");
    });
  });

  describe("missing content argument", () => {
    test("returns exitCode 1 with stderr containing 'missing content'", async () => {
      const ctx = makeCtx({
        PALIM_PUSH_URL: "http://localhost:3000/api/push",
        PALIM_SESSION_ID: "session-abc",
      });

      const result = await handler([], ctx);
      restoreFetch();

      expect(result.exitCode).toBe(1);
      expect(result.stderr.toLowerCase()).toContain("missing content");
      expect(fetchCalls).toHaveLength(0);
    });
  });

  describe("--type without value", () => {
    test("returns exitCode 1 with stderr error", async () => {
      const ctx = makeCtx({
        PALIM_PUSH_URL: "http://localhost:3000/api/push",
        PALIM_SESSION_ID: "session-abc",
      });

      const result = await handler(["--type"], ctx);
      restoreFetch();

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--type requires a value");
      expect(fetchCalls).toHaveLength(0);
    });
  });

  describe("missing environment variables", () => {
    test("returns exitCode 1 when PALIM_PUSH_URL is not set", async () => {
      const ctx = makeCtx({ PALIM_SESSION_ID: "session-abc" });

      const result = await handler(["content"], ctx);
      restoreFetch();

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("PALIM_PUSH_URL");
    });

    test("returns exitCode 1 when PALIM_SESSION_ID is not set", async () => {
      const ctx = makeCtx({ PALIM_PUSH_URL: "http://localhost:3000/api/push" });

      const result = await handler(["content"], ctx);
      restoreFetch();

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("PALIM_SESSION_ID");
    });
  });
});
