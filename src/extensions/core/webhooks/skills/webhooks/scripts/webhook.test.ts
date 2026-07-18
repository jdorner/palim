/**
 * Tests for the `webhook` skill script command.
 *
 * Uses a local HTTP server (Bun.serve) to mock the webhooks extension
 * API endpoints. The `test` subcommand fetches webhook details via
 * `GET /:slug` - same as production, no direct store imports.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { CommandContext, ExecResult } from "just-bash";
import { EMPTY_BYTES, InMemoryFs } from "just-bash";
import { buildWebhookCommand, type WebhookResponse } from "./webhook";

// ---------------------------------------------------------------------------

/** Builds a SkillScriptContext-shaped object for testing. */
function makeScriptCtx(baseUrl: string) {
  return { baseUrl, serverUrl: baseUrl, extensionsDir: "/tmp", fetch: globalThis.fetch, registerProgram() {} };
}
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal CommandContext sufficient for webhook handlers (they don't use fs/stdin). */
function makeCtx(): CommandContext {
  return { fs: new InMemoryFs(), cwd: "/home/user/work", env: new Map(), stdin: EMPTY_BYTES };
}

/** Tracks requests received by the mock server. */
interface ReceivedRequest {
  method: string;
  path: string;
  body?: unknown;
  headers: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("webhook command", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  let command: (args: string[], ctx: CommandContext) => Promise<ExecResult>;
  let received: ReceivedRequest[];

  /** In-memory webhook store - the mock server reads from this for GET /:slug. */
  let webhookStore: Map<string, WebhookResponse>;

  beforeEach(() => {
    received = [];
    webhookStore = new Map();

    // Mock API server
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname;
        let body: unknown;
        if (req.method === "POST" || req.method === "PUT") {
          body = await req.json().catch(() => undefined);
        }
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => {
          headers[k] = v;
        });
        received.push({ method: req.method, path, body, headers });

        // Route: GET / (list)
        if ((path === "/" || path === "") && req.method === "GET") {
          return Response.json([
            {
              slug: "github",
              name: "GitHub Webhook",
              authType: "hmac-sha256",
              headerName: "X-Hub-Signature-256",
              enabled: true,
              createdAt: "2026-01-01T00:00:00.000Z",
            },
            {
              slug: "stripe",
              name: "Stripe Events",
              authType: "bearer",
              headerName: "Authorization",
              enabled: false,
              createdAt: "2026-02-01T00:00:00.000Z",
            },
          ]);
        }

        // Route: POST / (create)
        if ((path === "/" || path === "") && req.method === "POST") {
          return Response.json({ ok: true }, { status: 201 });
        }

        // Route: POST /receive/:slug (test endpoint)
        if (path.startsWith("/receive/") && req.method === "POST") {
          return Response.json({ ok: true });
        }

        // Route: GET /:slug (single webhook with secret - used by test subcommand)
        if (req.method === "GET" && path.startsWith("/") && path.length > 1) {
          const slug = path.slice(1);
          const wh = webhookStore.get(slug);
          if (!wh) return Response.json({ error: "Not found" }, { status: 404 });
          return Response.json(wh);
        }

        // Route: DELETE /:slug
        if (req.method === "DELETE" && path.startsWith("/") && path.length > 1) {
          const slug = path.slice(1);
          if (slug === "not-found") {
            return Response.json({ error: "Not found" }, { status: 404 });
          }
          return Response.json({ ok: true });
        }

        // Route: PUT /:slug
        if (req.method === "PUT" && path.startsWith("/") && path.length > 1) {
          const slug = path.slice(1);
          if (slug === "not-found") {
            return Response.json({ error: "Not found" }, { status: 404 });
          }
          return Response.json({ ok: true });
        }

        return Response.json({ error: "Not found" }, { status: 404 });
      },
    });

    baseUrl = `http://localhost:${server.port}`;
    command = buildWebhookCommand(makeScriptCtx(baseUrl));
  });

  afterEach(() => {
    server.stop();
  });

  // ---------------------------------------------------------------------------
  // Help & routing
  // ---------------------------------------------------------------------------

  describe("routing", () => {
    test("shows help when no subcommand given", async () => {
      const result = await command([], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Manage webhook endpoints");
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
    test("lists registered webhooks", async () => {
      const result = await command(["list"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("github");
      expect(result.stdout).toContain("GitHub Webhook");
      expect(result.stdout).toContain("hmac-sha256");
      expect(result.stdout).toContain("enabled");
      expect(result.stdout).toContain("stripe");
      expect(result.stdout).toContain("disabled");
    });

    test("shows empty message when no webhooks exist", async () => {
      server.stop();
      server = Bun.serve({
        port: 0,
        fetch() {
          return Response.json([]);
        },
      });
      const emptyCommand = buildWebhookCommand(makeScriptCtx(`http://localhost:${server.port}`));

      const result = await emptyCommand(["list"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No webhooks registered.");
    });
  });

  // ---------------------------------------------------------------------------
  // get
  // ---------------------------------------------------------------------------

  describe("get", () => {
    test("shows details for an existing webhook", async () => {
      const result = await command(["get", "github"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Webhook: GitHub Webhook");
      expect(result.stdout).toContain("Slug: github");
      expect(result.stdout).toContain("Auth: hmac-sha256");
      expect(result.stdout).toContain("Header: X-Hub-Signature-256");
      expect(result.stdout).toContain("Endpoint: POST /ext/webhooks/receive/github");
    });

    test("returns error for non-existent webhook", async () => {
      const result = await command(["get", "nonexistent"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Webhook "nonexistent" not found.');
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
    test("creates a webhook with hmac-sha256 auth", async () => {
      const result = await command(["create", "my-hook", "My Hook", "hmac-sha256", "supersecret123"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Webhook created: "My Hook"');
      expect(result.stdout).toContain("Endpoint: POST /ext/webhooks/receive/my-hook");
      expect(result.stdout).toContain("Auth: hmac-sha256");

      const createReq = received.find((r) => r.path === "/" && r.method === "POST");
      expect(createReq).toBeDefined();
      expect(createReq!.body).toEqual({
        slug: "my-hook",
        name: "My Hook",
        authType: "hmac-sha256",
        secret: "supersecret123",
      });
    });

    test("creates a webhook with no auth", async () => {
      const result = await command(["create", "open-hook", "Open Hook", "none"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Auth: none");

      const createReq = received.find((r) => r.path === "/" && r.method === "POST");
      expect(createReq!.body).toEqual({
        slug: "open-hook",
        name: "Open Hook",
        authType: "none",
        secret: "",
      });
    });

    test("surfaces server error when authType none is rejected (production mode)", async () => {
      server.stop();
      server = Bun.serve({
        port: 0,
        async fetch(req) {
          const url = new URL(req.url);
          if ((url.pathname === "/" || url.pathname === "") && req.method === "POST") {
            return Response.json(
              { error: 'authType "none" is only allowed in development mode (NODE_ENV=development)' },
              { status: 400 },
            );
          }
          return Response.json({ error: "Not found" }, { status: 404 });
        },
      });
      const prodCommand = buildWebhookCommand(makeScriptCtx(`http://localhost:${server.port}`));

      const result = await prodCommand(["create", "open-hook", "Open Hook", "none"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("only allowed in development mode");
    });

    test("rejects invalid authType", async () => {
      const result = await command(["create", "hook", "Hook", "invalid", "secret123"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('authType must be "hmac-sha256", "bearer", or "none"');
    });

    test("rejects short secret for hmac-sha256", async () => {
      const result = await command(["create", "hook", "Hook", "hmac-sha256", "short"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("secret is required (min 8 chars)");
    });

    test("rejects missing secret for bearer auth", async () => {
      const result = await command(["create", "hook", "Hook", "bearer"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("secret is required (min 8 chars)");
    });

    test("requires slug, name, and authType arguments", async () => {
      const result = await command(["create"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Missing required argument");
    });
  });

  // ---------------------------------------------------------------------------
  // delete
  // ---------------------------------------------------------------------------

  describe("delete", () => {
    test("deletes an existing webhook", async () => {
      const result = await command(["delete", "github"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Webhook "github" deleted.');
    });

    test("reports error when webhook not found", async () => {
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
    test("updates a webhook field", async () => {
      const result = await command(["update", "github", "name", "New Name"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Webhook "github" updated: name = New Name');

      const updateReq = received.find((r) => r.method === "PUT");
      expect(updateReq).toBeDefined();
      expect(updateReq!.body).toEqual({ name: "New Name" });
    });

    test("coerces enabled field to boolean true", async () => {
      const result = await command(["update", "github", "enabled", "true"], makeCtx());
      expect(result.exitCode).toBe(0);

      const updateReq = received.find((r) => r.method === "PUT");
      expect(updateReq!.body).toEqual({ enabled: true });
    });

    test("coerces enabled field to boolean false", async () => {
      const result = await command(["update", "github", "enabled", "false"], makeCtx());
      expect(result.exitCode).toBe(0);

      const updateReq = received.find((r) => r.method === "PUT");
      expect(updateReq!.body).toEqual({ enabled: false });
    });

    test("rejects invalid enabled value", async () => {
      const result = await command(["update", "github", "enabled", "maybe"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('enabled must be "true" or "false"');
    });

    test("rejects invalid field name", async () => {
      const result = await command(["update", "github", "invalid-field", "value"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("invalid field");
      expect(result.stderr).toContain("Valid fields:");
    });

    test("reports error when webhook not found", async () => {
      const result = await command(["update", "not-found", "name", "X"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Error:");
    });

    test("surfaces server error when updating authType to none in production mode", async () => {
      server.stop();
      server = Bun.serve({
        port: 0,
        async fetch(req) {
          const url = new URL(req.url);
          if (req.method === "PUT" && url.pathname.startsWith("/") && url.pathname.length > 1) {
            return Response.json(
              { error: 'authType "none" is only allowed in development mode (NODE_ENV=development)' },
              { status: 400 },
            );
          }
          return Response.json({ error: "Not found" }, { status: 404 });
        },
      });
      const prodCommand = buildWebhookCommand(makeScriptCtx(`http://localhost:${server.port}`));

      const result = await prodCommand(["update", "github", "authType", "none"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("only allowed in development mode");
    });
  });

  // ---------------------------------------------------------------------------
  // test
  // ---------------------------------------------------------------------------

  describe("test", () => {
    test("sends authenticated test request with hmac-sha256", async () => {
      const secret = "my-webhook-secret";
      const payload = '{"event":"push"}';
      webhookStore.set("github", {
        slug: "github",
        name: "GitHub",
        authType: "hmac-sha256",
        secret,
        headerName: "X-Hub-Signature-256",
        enabled: true,
      });

      const result = await command(["test", "github", payload], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Test successful");

      // Verify HMAC was computed correctly
      const testReq = received.find((r) => r.path === "/receive/github");
      expect(testReq).toBeDefined();
      const expectedHmac = createHmac("sha256", secret).update(payload).digest("hex");
      expect(testReq!.headers["x-hub-signature-256"]).toBe(`sha256=${expectedHmac}`);
    });

    test("sends authenticated test request with bearer token", async () => {
      webhookStore.set("stripe", {
        slug: "stripe",
        name: "Stripe",
        authType: "bearer",
        secret: "whsec_test_token",
        headerName: "Authorization",
        enabled: true,
      });

      const result = await command(["test", "stripe", '{"type":"invoice.paid"}'], makeCtx());
      expect(result.exitCode).toBe(0);

      const testReq = received.find((r) => r.path === "/receive/stripe");
      expect(testReq!.headers.authorization).toBe("whsec_test_token");
    });

    test("sends test request without auth for none type", async () => {
      webhookStore.set("open", {
        slug: "open",
        name: "Open",
        authType: "none",
        secret: "",
        headerName: "",
        enabled: true,
      });

      const result = await command(["test", "open", '{"ping":true}'], makeCtx());
      expect(result.exitCode).toBe(0);
    });

    test("rejects invalid JSON payload", async () => {
      const result = await command(["test", "github", "not-json"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("payload must be valid JSON");
    });

    test("returns error when webhook not found", async () => {
      const result = await command(["test", "nonexistent", '{"x":1}'], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Webhook "nonexistent" not found');
    });

    test("returns error when webhook is disabled", async () => {
      webhookStore.set("disabled-hook", {
        slug: "disabled-hook",
        name: "Disabled",
        authType: "none",
        secret: "",
        headerName: "",
        enabled: false,
      });

      const result = await command(["test", "disabled-hook", '{"x":1}'], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Webhook "disabled-hook" is disabled');
    });

    test("requires slug and payload arguments", async () => {
      const result = await command(["test"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Missing required argument");
    });
  });

  // ---------------------------------------------------------------------------
  // Network error handling
  // ---------------------------------------------------------------------------

  describe("network errors", () => {
    test("handles connection refused gracefully", async () => {
      const deadCommand = buildWebhookCommand(makeScriptCtx("http://localhost:1"));
      const result = await deadCommand(["list"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Error:");
    });
  });
});
