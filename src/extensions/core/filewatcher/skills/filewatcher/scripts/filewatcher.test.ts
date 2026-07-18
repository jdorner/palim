/**
 * Tests for the `filewatcher` skill script command.
 *
 * Uses a local HTTP server (Bun.serve) to mock the filewatcher extension API.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CommandContext, ExecResult } from "just-bash";
import { EMPTY_BYTES, InMemoryFs } from "just-bash";
import { buildFilewatcherCommand } from "./filewatcher";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeCtx(): CommandContext {
  return { fs: new InMemoryFs(), cwd: "/home/user/work", env: new Map(), stdin: EMPTY_BYTES };
}

interface ReceivedRequest {
  method: string;
  path: string;
  body?: unknown;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("filewatcher command", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  let command: (args: string[], ctx: CommandContext) => Promise<ExecResult>;
  let received: ReceivedRequest[];

  beforeEach(() => {
    received = [];

    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const reqPath = url.pathname;
        let body: unknown;
        if (req.method === "POST" || req.method === "PUT") {
          body = await req.json().catch(() => undefined);
        }
        received.push({ method: req.method, path: reqPath, body });

        // GET /
        if ((reqPath === "/" || reqPath === "") && req.method === "GET") {
          return Response.json([
            {
              slug: "inbox-images",
              name: "Inbox Images",
              path: "inbox",
              patterns: ["*.png", "*.jpg"],
              recursive: false,
              processExisting: false,
              enabled: true,
              createdAt: "2026-01-15T10:00:00.000Z",
            },
            {
              slug: "docs-watcher",
              name: "Document Watcher",
              path: "data/raw",
              patterns: ["*.pdf"],
              recursive: true,
              processExisting: true,
              enabled: false,
              createdAt: "2026-02-01T08:00:00.000Z",
            },
          ]);
        }

        // POST /
        if ((reqPath === "/" || reqPath === "") && req.method === "POST") {
          return Response.json({ ok: true }, { status: 201 });
        }

        // DELETE /:slug
        if (reqPath.startsWith("/") && req.method === "DELETE") {
          const slug = reqPath.slice(1);
          if (slug === "not-found") {
            return Response.json({ error: "Not found" }, { status: 404 });
          }
          return Response.json({ ok: true });
        }

        // PUT /:slug
        if (reqPath.startsWith("/") && req.method === "PUT") {
          const slug = reqPath.slice(1);
          if (slug === "not-found") {
            return Response.json({ error: "Not found" }, { status: 404 });
          }
          return Response.json({ ok: true });
        }

        return Response.json({ error: "Not found" }, { status: 404 });
      },
    });

    baseUrl = `http://localhost:${server.port}`;
    command = buildFilewatcherCommand({
      baseUrl,
      serverUrl: baseUrl,
      extensionsDir: "/tmp",
      fetch: globalThis.fetch,
      registerProgram() {},
    });
  });

  afterEach(() => {
    server.stop();
  });

  // ---------------------------------------------------------------------------
  // Routing
  // ---------------------------------------------------------------------------

  describe("routing", () => {
    test("shows help when no subcommand given", async () => {
      const result = await command([], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Manage directory watchers");
      expect(result.stdout).toContain("list");
      expect(result.stdout).toContain("create");
    });

    test("shows error for unknown subcommand", async () => {
      const result = await command(["unknown"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unknown command "unknown"');
    });
  });

  // ---------------------------------------------------------------------------
  // list
  // ---------------------------------------------------------------------------

  describe("list", () => {
    test("lists registered file watchers", async () => {
      const result = await command(["list"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("inbox-images");
      expect(result.stdout).toContain("Inbox Images");
      expect(result.stdout).toContain("enabled");
      expect(result.stdout).toContain("*.png, *.jpg");
      expect(result.stdout).toContain("docs-watcher");
      expect(result.stdout).toContain("disabled");
      expect(result.stdout).toContain("recursive");
      expect(result.stdout).toContain("processExisting");
    });

    test("shows empty message when no watchers exist", async () => {
      server.stop();
      server = Bun.serve({
        port: 0,
        fetch() {
          return Response.json([]);
        },
      });
      const emptyCommand = buildFilewatcherCommand({
        baseUrl: `http://localhost:${server.port}`,
        serverUrl: `http://localhost:${server.port}`,
        extensionsDir: "/tmp",
        fetch: globalThis.fetch,
        registerProgram() {},
      });

      const result = await emptyCommand(["list"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No file watchers registered.");
    });
  });

  // ---------------------------------------------------------------------------
  // get
  // ---------------------------------------------------------------------------

  describe("get", () => {
    test("shows details for an existing watcher", async () => {
      const result = await command(["get", "inbox-images"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("File Watcher: Inbox Images");
      expect(result.stdout).toContain("Slug: inbox-images");
      expect(result.stdout).toContain("Path: inbox");
      expect(result.stdout).toContain("*.png, *.jpg");
      expect(result.stdout).toContain("Recursive: false");
      expect(result.stdout).toContain("Enabled: true");
    });

    test("returns error for non-existent watcher", async () => {
      const result = await command(["get", "nonexistent"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('File watcher "nonexistent" not found.');
    });

    test("requires slug argument", async () => {
      const result = await command(["get"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Missing required argument");
    });
  });

  // ---------------------------------------------------------------------------
  // create
  // ---------------------------------------------------------------------------

  describe("create", () => {
    test("creates a file watcher", async () => {
      const result = await command(["create", "my-watcher", "My Watcher", "inbox", "*.pdf,*.docx"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('File watcher created: "My Watcher"');
      expect(result.stdout).toContain("Path: inbox");
      expect(result.stdout).toContain("Patterns: *.pdf, *.docx");
      expect(result.stdout).toContain("Recursive: false");
      expect(result.stdout).toContain("Process Existing: false");

      const req = received.find((r) => r.path === "/" && r.method === "POST");
      expect(req).toBeDefined();
      expect(req!.body).toEqual({
        slug: "my-watcher",
        name: "My Watcher",
        path: "inbox",
        patterns: ["*.pdf", "*.docx"],
        recursive: false,
        processExisting: false,
      });
    });

    test("creates with recursive and processExisting flags", async () => {
      const result = await command(
        ["create", "--recursive", "--process-existing", "deep-watcher", "Deep", "data", "*.txt"],
        makeCtx(),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Recursive: true");
      expect(result.stdout).toContain("Process Existing: true");

      const req = received.find((r) => r.path === "/" && r.method === "POST");
      expect(req!.body).toEqual({
        slug: "deep-watcher",
        name: "Deep",
        path: "data",
        patterns: ["*.txt"],
        recursive: true,
        processExisting: true,
      });
    });

    test("rejects empty patterns", async () => {
      // Empty string for a required arg is caught by the arg parser as "missing"
      const result = await command(["create", "bad", "Bad", "inbox", "   "], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("at least one glob pattern is required");
    });

    test("requires slug, name, path, and patterns arguments", async () => {
      const result = await command(["create"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Missing required argument");
    });
  });

  // ---------------------------------------------------------------------------
  // delete
  // ---------------------------------------------------------------------------

  describe("delete", () => {
    test("deletes an existing watcher", async () => {
      const result = await command(["delete", "inbox-images"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('File watcher "inbox-images" deleted.');
    });

    test("reports error when watcher not found", async () => {
      const result = await command(["delete", "not-found"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Error:");
    });

    test("requires slug argument", async () => {
      const result = await command(["delete"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Missing required argument");
    });
  });

  // ---------------------------------------------------------------------------
  // update
  // ---------------------------------------------------------------------------

  describe("update", () => {
    test("updates a string field", async () => {
      const result = await command(["update", "inbox-images", "name", "New Name"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('File watcher "inbox-images" updated: name = New Name');

      const req = received.find((r) => r.method === "PUT");
      expect(req!.body).toEqual({ name: "New Name" });
    });

    test("updates path field", async () => {
      const result = await command(["update", "inbox-images", "path", "outbox"], makeCtx());
      expect(result.exitCode).toBe(0);

      const req = received.find((r) => r.method === "PUT");
      expect(req!.body).toEqual({ path: "outbox" });
    });

    test("coerces enabled to boolean true", async () => {
      const result = await command(["update", "inbox-images", "enabled", "true"], makeCtx());
      expect(result.exitCode).toBe(0);

      const req = received.find((r) => r.method === "PUT");
      expect(req!.body).toEqual({ enabled: true });
    });

    test("coerces recursive to boolean false", async () => {
      const result = await command(["update", "inbox-images", "recursive", "false"], makeCtx());
      expect(result.exitCode).toBe(0);

      const req = received.find((r) => r.method === "PUT");
      expect(req!.body).toEqual({ recursive: false });
    });

    test("coerces processExisting to boolean", async () => {
      const result = await command(["update", "inbox-images", "processExisting", "true"], makeCtx());
      expect(result.exitCode).toBe(0);

      const req = received.find((r) => r.method === "PUT");
      expect(req!.body).toEqual({ processExisting: true });
    });

    test("rejects invalid boolean value", async () => {
      const result = await command(["update", "inbox-images", "enabled", "maybe"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('enabled must be "true" or "false"');
    });

    test("parses patterns as comma-separated array", async () => {
      const result = await command(["update", "inbox-images", "patterns", "*.png,*.gif,*.webp"], makeCtx());
      expect(result.exitCode).toBe(0);

      const req = received.find((r) => r.method === "PUT");
      expect(req!.body).toEqual({ patterns: ["*.png", "*.gif", "*.webp"] });
    });

    test("rejects empty patterns", async () => {
      // Whitespace-only value passes arg parsing but results in empty array after split+trim+filter
      const result = await command(["update", "inbox-images", "patterns", "   "], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("at least one glob pattern is required");
    });

    test("rejects invalid field name", async () => {
      const result = await command(["update", "inbox-images", "invalid-field", "value"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("invalid field");
      expect(result.stderr).toContain("Valid fields:");
    });

    test("reports error when watcher not found", async () => {
      const result = await command(["update", "not-found", "name", "X"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Error:");
    });
  });

  // ---------------------------------------------------------------------------
  // Network errors
  // ---------------------------------------------------------------------------

  describe("network errors", () => {
    test("handles connection refused gracefully", async () => {
      const deadCommand = buildFilewatcherCommand({
        baseUrl: "http://localhost:1",
        serverUrl: "http://localhost:1",
        extensionsDir: "/tmp",
        fetch: globalThis.fetch,
        registerProgram() {},
      });
      const result = await deadCommand(["list"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Error:");
    });
  });
});
