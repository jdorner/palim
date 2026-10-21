import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

describe("createShell file access", () => {
  // Regression (Bun 1.4): the first node:fs/promises file handle of a process
  // creates a FinalizationRegistry, which just-bash blocks during exec, so every
  // read and write in the sandbox failed. Needs a fresh process: any handle
  // opened earlier in the test run would mask the bug.
  test("reads and writes work-dir files when the first file handle is opened in the sandbox", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "sandbox-fh-"));
    try {
      await Bun.write(path.join(workDir, "tasks.md"), "- [ ] goblin\n");
      const script = `
        import { createShell } from "./src/tools/sandbox";
        const sh = await createShell({ skills: [], resolveSkill: () => undefined, workDir: process.env.SANDBOX_TEST_WORK_DIR });
        const result = await sh.exec("cat tasks.md && echo '- [x] troll' >> tasks.md && cat tasks.md");
        process.stdout.write(JSON.stringify(result));
      `;
      const proc = Bun.spawn([process.execPath, "-e", script], {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: { ...process.env, SANDBOX_TEST_WORK_DIR: workDir },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      expect(await proc.exited, stderr).toBe(0);

      const result = JSON.parse(stdout);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("- [ ] goblin\n- [ ] goblin\n- [x] troll\n");
      expect(await Bun.file(path.join(workDir, "tasks.md")).text()).toBe("- [ ] goblin\n- [x] troll\n");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
