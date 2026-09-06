/**
 * Tests for the `convert` skill script command.
 *
 * The command reads `--file` inputs from the virtual InMemoryFs and posts them
 * to the converter endpoint as base64 `data` (with original basenames in
 * `filenames`). A local mock server via Bun.serve captures the request body so
 * the payload shape can be asserted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CommandContext, ExecResult } from "just-bash";
import { EMPTY_BYTES, InMemoryFs } from "just-bash";
import { buildConvertCommand } from "./convert";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Builds a SkillScriptContext-shaped object for testing. */
function makeScriptCtx(baseUrl: string) {
  return { baseUrl, serverUrl: baseUrl, extensionsDir: "/tmp", fetch: globalThis.fetch, registerProgram() {} };
}

/** Virtual cwd matching the sandbox mount point. */
const CWD = "/home/user/work";

/** Payload shape the mock server records for assertions. */
interface ConvertPayload {
  data?: string[];
  filenames?: string[];
  prompt?: string;
}

function makeCtx(): CommandContext {
  const fs = new InMemoryFs();
  return { fs, cwd: CWD, env: new Map(), stdin: EMPTY_BYTES };
}

/**
 * Creates a context with pre-populated binary files under the cwd.
 * Contents are written as raw bytes so base64 round-tripping can be verified.
 */
async function makeCtxWithFiles(files: Record<string, Uint8Array>): Promise<CommandContext> {
  const ctx = makeCtx();
  await ctx.fs.mkdir(CWD, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) {
    await ctx.fs.writeFile(ctx.fs.resolvePath(CWD, name), bytes);
  }
  return ctx;
}

/** Returns the bytes of a tiny valid-ish PNG-like blob (content is arbitrary for these tests). */
function fakeBytes(seed: number): Uint8Array {
  return Uint8Array.from([seed, 0x50, 0x4e, 0x47, seed + 1, 0xff, 0x00, seed + 2]);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("convert command", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  let command: (args: string[], ctx: CommandContext) => Promise<ExecResult>;
  let received: Array<{ method: string; path: string; body?: ConvertPayload }>;

  beforeEach(() => {
    received = [];

    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        let body: ConvertPayload | undefined;
        if (req.method === "POST") {
          body = (await req.json().catch(() => undefined)) as ConvertPayload | undefined;
        }
        received.push({ method: req.method, path: url.pathname, body });

        if (url.pathname === "/convert" && req.method === "POST") {
          return Response.json({ markdown: "# Extracted" });
        }
        return Response.json({ error: "Not found" }, { status: 404 });
      },
    });

    baseUrl = `http://localhost:${server.port}`;
    command = buildConvertCommand(makeScriptCtx(baseUrl));
  });

  afterEach(() => {
    server.stop();
  });

  // -------------------------------------------------------------------------
  // Argument handling
  // -------------------------------------------------------------------------

  describe("argument handling", () => {
    test("shows help with --help", async () => {
      const result = await command(["--help"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Convert files");
    });

    test("errors when no input is provided", async () => {
      const result = await command([], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No input provided");
    });

    test("errors on unknown option", async () => {
      const result = await command(["--bogus"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown option");
    });
  });

  // -------------------------------------------------------------------------
  // --file input (read via ctx.fs, sent as base64 data + filenames)
  // -------------------------------------------------------------------------

  describe("--file input", () => {
    test("reads a file from the sandbox fs and sends base64 data with its basename", async () => {
      const bytes = fakeBytes(1);
      const ctx = await makeCtxWithFiles({ "inbox/IMG_0569.jpg": bytes });

      const result = await command(["--file", "inbox/IMG_0569.jpg"], ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("# Extracted");

      const req = received.find((r) => r.path === "/convert");
      expect(req).toBeDefined();
      expect(req!.body!.data).toEqual([Buffer.from(bytes).toString("base64")]);
      expect(req!.body!.filenames).toEqual(["IMG_0569.jpg"]);
    });

    test("preserves the original basename regardless of the directory in the path", async () => {
      const ctx = await makeCtxWithFiles({ "data/raw/scan.pdf": fakeBytes(2) });

      const result = await command(["--file", "data/raw/scan.pdf"], ctx);
      expect(result.exitCode).toBe(0);

      const req = received.find((r) => r.path === "/convert");
      expect(req!.body!.filenames).toEqual(["scan.pdf"]);
    });

    test("sends multiple files as ordered data and filenames arrays", async () => {
      const a = fakeBytes(3);
      const b = fakeBytes(4);
      const ctx = await makeCtxWithFiles({ "page1.png": a, "page2.png": b });

      const result = await command(["--file", "page1.png", "--file", "page2.png"], ctx);
      expect(result.exitCode).toBe(0);

      const req = received.find((r) => r.path === "/convert");
      expect(req!.body!.data).toEqual([Buffer.from(a).toString("base64"), Buffer.from(b).toString("base64")]);
      expect(req!.body!.filenames).toEqual(["page1.png", "page2.png"]);
    });

    test("returns a read error when a --file input does not exist", async () => {
      const result = await command(["--file", "missing.jpg"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("could not read missing.jpg");
      // Nothing should have been posted to the server.
      expect(received.find((r) => r.path === "/convert")).toBeUndefined();
    });

    test("forwards a custom prompt", async () => {
      const ctx = await makeCtxWithFiles({ "photo.png": fakeBytes(5) });

      const result = await command(["--file", "photo.png", "--prompt", "Is there a blue ball?"], ctx);
      expect(result.exitCode).toBe(0);

      const req = received.find((r) => r.path === "/convert");
      expect(req!.body!.prompt).toBe("Is there a blue ball?");
    });

    test("writes markdown to --output instead of stdout", async () => {
      const ctx = await makeCtxWithFiles({ "photo.png": fakeBytes(6) });

      const result = await command(["--file", "photo.png", "--output", "out/result.md"], ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Markdown written to out/result.md");

      const written = await ctx.fs.readFile(ctx.fs.resolvePath(CWD, "out/result.md"));
      expect(written).toBe("# Extracted");
    });
  });

  // -------------------------------------------------------------------------
  // stdin input
  // -------------------------------------------------------------------------

  describe("stdin input", () => {
    test("sends piped bytes as base64 data without filenames", async () => {
      const ctx = makeCtx();
      // just-bash carries stdin as a latin1-shaped byte string.
      const raw = "\x89PNG\x01\x02";
      ctx.stdin = raw as unknown as typeof ctx.stdin;

      const result = await command([], ctx);
      expect(result.exitCode).toBe(0);

      const req = received.find((r) => r.path === "/convert");
      expect(req!.body!.data).toHaveLength(1);
      expect(req!.body!.filenames).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Error propagation
  // -------------------------------------------------------------------------

  describe("errors", () => {
    test("surfaces HTTP errors from the endpoint", async () => {
      // Point at a path that the mock server 404s (endpoint mismatch).
      const badCommand = buildConvertCommand(makeScriptCtx(`${baseUrl}/nope`));
      const ctx = await makeCtxWithFiles({ "photo.png": fakeBytes(7) });

      const result = await badCommand(["--file", "photo.png"], ctx);
      expect(result.exitCode).toBe(1);
    });

    test("handles connection refused gracefully", async () => {
      const deadCommand = buildConvertCommand(makeScriptCtx("http://localhost:1"));
      const ctx = await makeCtxWithFiles({ "photo.png": fakeBytes(8) });

      const result = await deadCommand(["--file", "photo.png"], ctx);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Error:");
    });
  });
});
