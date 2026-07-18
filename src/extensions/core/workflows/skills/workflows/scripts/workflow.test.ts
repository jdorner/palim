/**
 * Tests for the `workflow` skill script command.
 *
 * File-based subcommands (list, read, write, validate, delete) use the
 * virtual InMemoryFs. HTTP-based subcommands (trigger, runs, logs) use
 * a local mock server via Bun.serve.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CommandContext, ExecResult } from "just-bash";
import { EMPTY_BYTES, InMemoryFs } from "just-bash";
import { buildWorkflowCommand } from "./workflow";

// ---------------------------------------------------------------------------

/** Builds a SkillScriptContext-shaped object for testing. */
function makeScriptCtx(baseUrl: string) {
  return { baseUrl, serverUrl: baseUrl, extensionsDir: "/tmp", fetch: globalThis.fetch, registerProgram() {} };
}
// Test helpers
// ---------------------------------------------------------------------------

/** Virtual cwd matching the sandbox mount point. */
const CWD = "/home/user/work";
const WORKFLOWS_DIR = `${CWD}/workflows`;

function makeCtx(): CommandContext {
  const fs = new InMemoryFs();
  return { fs, cwd: CWD, env: new Map(), stdin: EMPTY_BYTES };
}

/**
 * Creates a context with pre-populated workflow files.
 */
async function makeCtxWithFiles(files: Record<string, string>): Promise<CommandContext> {
  const ctx = makeCtx();
  await ctx.fs.mkdir(WORKFLOWS_DIR, { recursive: true });
  await ctx.fs.writeFile(ctx.fs.resolvePath(WORKFLOWS_DIR, ".gitkeep"), "");
  for (const [name, content] of Object.entries(files)) {
    await ctx.fs.writeFile(ctx.fs.resolvePath(WORKFLOWS_DIR, name), content);
  }
  return ctx;
}

/** A minimal valid workflow JSON5 string. */
const VALID_WORKFLOW = `{
  "name": "deploy-app",
  "description": "Deploy the application",
  "trigger": { "type": "manual" },
  "steps": [
    { "slug": "build", "type": "agent", "prompt": "Build the application" }
  ]
}`;

/** A workflow with two steps. */
const TWO_STEP_WORKFLOW = `{
  "name": "two-step",
  "trigger": { "type": "webhook", "ref": "github" },
  "steps": [
    { "slug": "lint", "type": "agent", "prompt": "Run linting" },
    { "slug": "deploy", "type": "webhook", "url": "https://example.com/deploy" }
  ]
}`;

/** A workflow with duplicate step slugs. */
const DUPLICATE_SLUG_WORKFLOW = `{
  "name": "bad-workflow",
  "trigger": { "type": "manual" },
  "steps": [
    { "slug": "build", "type": "agent", "prompt": "First step" },
    { "slug": "build", "type": "agent", "prompt": "Duplicate slug" }
  ]
}`;

/** Invalid JSON5 (missing required fields - empty steps). */
const INVALID_WORKFLOW = `{
  "name": "missing-stuff",
  "trigger": { "type": "manual" },
  "steps": []
}`;

/** A workflow with additional properties not in the schema. */
const EXTRA_PROPS_WORKFLOW = `{
  "name": "extra-props",
  "trigger": { "type": "manual", "ref": "something", "extraTriggerProp": "should-fail" },
  "steps": [
    { "slug": "build", "type": "agent", "prompt": "Build it" }
  ]
}`;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("workflow command", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  let command: (args: string[], ctx: CommandContext) => Promise<ExecResult>;
  let received: Array<{ method: string; path: string; body?: unknown }>;

  beforeEach(() => {
    received = [];

    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const reqPath = url.pathname;
        let body: unknown;
        if (req.method === "POST") {
          body = await req.json().catch(() => undefined);
        }
        received.push({ method: req.method, path: reqPath, body });

        // DELETE /runs/:runId - cancel a workflow run
        if (reqPath.match(/^\/runs\/[^/]+$/) && req.method === "DELETE") {
          const runId = reqPath.split("/")[2];
          if (runId === "not-found") {
            return Response.json({ error: "Not found" }, { status: 404 });
          }
          return Response.json({ runId, cancelled: ["job-001", "job-002"], total: 2 });
        }

        // POST /run/:name - trigger
        if (reqPath.startsWith("/run/") && req.method === "POST") {
          const name = reqPath.replace("/run/", "");
          if (name === "not-found") {
            return Response.json({ error: "Workflow not found" }, { status: 404 });
          }
          return Response.json({ ok: true, workflowRunId: "run-abc-123" });
        }

        // GET /runs/:runId/logs
        if (reqPath.match(/^\/runs\/[^/]+\/logs$/) && req.method === "GET") {
          const runId = reqPath.split("/")[2];
          if (runId === "not-found") {
            return Response.json({ error: "Not found" }, { status: 404 });
          }
          return Response.json({
            runId,
            steps: [
              {
                slug: "build",
                type: "agent",
                status: "completed",
                logs: ["[info] Build started", "Build done"],
                count: 2,
              },
              { slug: "deploy", type: "webhook", status: "failed", logs: [], count: 0 },
            ],
          });
        }

        // GET /runs/:runId - run details (for cancel subcommand)
        if (reqPath.match(/^\/runs\/[^/]+$/) && req.method === "GET") {
          const runId = reqPath.split("/")[2];
          if (runId === "not-found") {
            return Response.json({ error: "Not found" }, { status: 404 });
          }
          if (runId === "empty-steps") {
            return Response.json({ runId, workflowName: "test", status: "waiting", steps: [] });
          }
          return Response.json({
            runId,
            workflowName: "deploy-app",
            status: "active",
            steps: [
              { slug: "build", type: "agent", status: "completed", jobId: "job-001" },
              { slug: "deploy", type: "webhook", status: "waiting", jobId: "job-002" },
            ],
          });
        }

        // GET /:name - workflow detail with runs
        if (req.method === "GET" && reqPath !== "/") {
          const name = reqPath.slice(1);
          if (name === "not-found") {
            return Response.json({ error: "Not found" }, { status: 404 });
          }
          if (name === "empty-runs") {
            return Response.json({ name, runs: [] });
          }
          return Response.json({
            name,
            runs: [
              {
                runId: "run-001",
                status: "completed",
                startedAt: 1714500000000,
                steps: [{ slug: "build", status: "completed", jobId: "j1" }],
              },
              {
                runId: "run-002",
                status: "failed",
                startedAt: 1714600000000,
                steps: [
                  { slug: "build", status: "completed", jobId: "j2" },
                  { slug: "deploy", status: "failed", jobId: "j3" },
                ],
              },
            ],
          });
        }

        return Response.json({ error: "Not found" }, { status: 404 });
      },
    });

    baseUrl = `http://localhost:${server.port}`;
    command = buildWorkflowCommand(makeScriptCtx(baseUrl));
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
      expect(result.stdout).toContain("Manage workflow pipeline");
      expect(result.stdout).toContain("list");
      expect(result.stdout).toContain("trigger");
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
    test("shows empty message when no workflows exist", async () => {
      const result = await command(["list"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No workflows found");
    });

    test("lists workflows with metadata", async () => {
      const ctx = await makeCtxWithFiles({
        "deploy-app.json5": VALID_WORKFLOW,
        "two-step.json5": TWO_STEP_WORKFLOW,
      });

      const result = await command(["list"], ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("deploy-app");
      expect(result.stdout).toContain("1 steps");
      expect(result.stdout).toContain("trigger: manual");
      expect(result.stdout).toContain("two-step");
      expect(result.stdout).toContain("2 steps");
      expect(result.stdout).toContain("trigger: webhook");
    });

    test("shows disabled flag for disabled workflows", async () => {
      const disabled = `{"name": "disabled-wf", "trigger": {"type": "manual"}, "enabled": false, "steps": [{"slug": "s", "type": "agent", "prompt": "x"}]}`;
      const ctx = await makeCtxWithFiles({ "disabled-wf.json5": disabled });

      const result = await command(["list"], ctx);
      expect(result.stdout).toContain("[disabled]");
    });

    test("handles parse errors gracefully", async () => {
      const ctx = await makeCtxWithFiles({ "broken.json5": "{{{{invalid json5" });

      const result = await command(["list"], ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("broken.json5");
    });
  });

  // ---------------------------------------------------------------------------
  // read
  // ---------------------------------------------------------------------------

  describe("read", () => {
    test("reads an existing workflow file", async () => {
      const ctx = await makeCtxWithFiles({ "deploy-app.json5": VALID_WORKFLOW });

      const result = await command(["read", "deploy-app"], ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(VALID_WORKFLOW);
    });

    test("returns error for non-existent workflow", async () => {
      const result = await command(["read", "nonexistent"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Workflow "nonexistent" not found');
    });

    test("requires name argument", async () => {
      const result = await command(["read"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Missing required argument");
    });
  });

  // ---------------------------------------------------------------------------
  // write
  // ---------------------------------------------------------------------------

  describe("write", () => {
    test("writes a valid workflow file", async () => {
      const ctx = makeCtx();
      const result = await command(["write", "deploy-app", VALID_WORKFLOW], ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Workflow "deploy-app" written');

      // Verify file was actually written to the virtual fs
      const filePath = ctx.fs.resolvePath(WORKFLOWS_DIR, "deploy-app.json5");
      const content = await ctx.fs.readFile(filePath);
      expect(Bun.JSON5.parse(content)).toStrictEqual(Bun.JSON5.parse(VALID_WORKFLOW));
    });

    test("rejects invalid workflow (schema validation)", async () => {
      const result = await command(["write", "bad", INVALID_WORKFLOW], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Validation failed");
    });

    test("rejects workflow with duplicate step slugs", async () => {
      const result = await command(["write", "dup", DUPLICATE_SLUG_WORKFLOW], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("duplicate step slug");
    });

    test("rejects invalid JSON5 syntax", async () => {
      const result = await command(["write", "broken", "{{not valid json5"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("JSON5 parse error");
    });

    test("rejects workflow with additional properties not in schema", async () => {
      const result = await command(["write", "extra", EXTRA_PROPS_WORKFLOW], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Validation failed");
    });

    test("creates workflows directory if it does not exist", async () => {
      const ctx = makeCtx();
      const result = await command(["write", "deploy-app", VALID_WORKFLOW], ctx);
      expect(result.exitCode).toBe(0);

      const markerPath = ctx.fs.resolvePath(WORKFLOWS_DIR, ".gitkeep");
      const exists = await ctx.fs.exists(markerPath);
      expect(exists).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // validate
  // ---------------------------------------------------------------------------

  describe("validate", () => {
    test("validates a correct workflow", async () => {
      const ctx = await makeCtxWithFiles({ "deploy-app.json5": VALID_WORKFLOW });

      const result = await command(["validate", "deploy-app"], ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("is valid");
      expect(result.stdout).toContain("1 steps");
    });

    test("reports schema errors for invalid workflow", async () => {
      const ctx = await makeCtxWithFiles({ "bad.json5": INVALID_WORKFLOW });

      const result = await command(["validate", "bad"], ctx);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Schema validation failed");
    });

    test("reports duplicate step slugs", async () => {
      const ctx = await makeCtxWithFiles({ "dup.json5": DUPLICATE_SLUG_WORKFLOW });

      const result = await command(["validate", "dup"], ctx);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("duplicate step slug");
    });

    test("reports JSON5 syntax errors", async () => {
      const ctx = await makeCtxWithFiles({ "broken.json5": "{{{{invalid" });

      const result = await command(["validate", "broken"], ctx);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("JSON5 syntax error");
    });

    test("rejects workflow with additional properties not in schema", async () => {
      const ctx = await makeCtxWithFiles({ "extra.json5": EXTRA_PROPS_WORKFLOW });

      const result = await command(["validate", "extra"], ctx);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Schema validation failed");
    });

    test("returns error for non-existent workflow", async () => {
      const result = await command(["validate", "nonexistent"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Workflow "nonexistent" not found');
    });
  });

  // ---------------------------------------------------------------------------
  // delete
  // ---------------------------------------------------------------------------

  describe("delete", () => {
    test("deletes an existing workflow", async () => {
      const ctx = await makeCtxWithFiles({ "deploy-app.json5": VALID_WORKFLOW });

      const result = await command(["delete", "deploy-app"], ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Workflow "deploy-app" deleted');

      const filePath = ctx.fs.resolvePath(WORKFLOWS_DIR, "deploy-app.json5");
      const exists = await ctx.fs.exists(filePath);
      expect(exists).toBe(false);
    });

    test("returns error for non-existent workflow", async () => {
      const result = await command(["delete", "nonexistent"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Workflow "nonexistent" not found');
    });
  });

  // ---------------------------------------------------------------------------
  // trigger
  // ---------------------------------------------------------------------------

  describe("trigger", () => {
    test("triggers a workflow run", async () => {
      const result = await command(["trigger", "deploy-app"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Workflow "deploy-app" triggered');
      expect(result.stdout).toContain("run-abc-123");

      const req = received.find((r) => r.path === "/run/deploy-app");
      expect(req).toBeDefined();
      expect(req!.method).toBe("POST");
    });

    test("triggers with a JSON payload", async () => {
      const payload = '{"version":"1.2.3"}';
      const result = await command(["trigger", "deploy-app", payload], makeCtx());
      expect(result.exitCode).toBe(0);

      const req = received.find((r) => r.path === "/run/deploy-app");
      expect(req!.body).toEqual({ version: "1.2.3" });
    });

    test("rejects invalid JSON payload", async () => {
      const result = await command(["trigger", "deploy-app", "not-json"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("payload must be valid JSON");
    });

    test("reports error when workflow not found", async () => {
      const result = await command(["trigger", "not-found"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Error:");
    });
  });

  // ---------------------------------------------------------------------------
  // runs
  // ---------------------------------------------------------------------------

  describe("runs", () => {
    test("lists runs for a workflow", async () => {
      const result = await command(["runs", "deploy-app"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("run-001");
      expect(result.stdout).toContain("completed");
      expect(result.stdout).toContain("run-002");
      expect(result.stdout).toContain("failed");
    });

    test("shows empty message when no runs exist", async () => {
      const result = await command(["runs", "empty-runs"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No runs found");
    });

    test("reports error when workflow not found", async () => {
      const result = await command(["runs", "not-found"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("not found");
    });
  });

  // ---------------------------------------------------------------------------
  // logs
  // ---------------------------------------------------------------------------

  describe("logs", () => {
    test("shows per-step logs for a run", async () => {
      const result = await command(["logs", "run-001"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Run: run-001");
      expect(result.stdout).toContain("build");
      expect(result.stdout).toContain("agent");
      expect(result.stdout).toContain("completed");
      expect(result.stdout).toContain("Build done");
      expect(result.stdout).toContain("deploy");
      expect(result.stdout).toContain("(no logs)");
    });

    test("reports error when run not found", async () => {
      const result = await command(["logs", "not-found"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Run "not-found" not found');
    });
  });

  // ---------------------------------------------------------------------------
  // cancel
  // ---------------------------------------------------------------------------

  describe("cancel", () => {
    test("cancels a running workflow by run ID", async () => {
      const result = await command(["cancel", "run-001"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Cancelled workflow run run-001");
      expect(result.stdout).toContain("2 steps");
      expect(result.stdout).toContain("build");
      expect(result.stdout).toContain("deploy");

      // Verify it hit the DELETE endpoint for the run
      const cancelReq = received.find((r) => r.path === "/runs/run-001" && r.method === "DELETE");
      expect(cancelReq).toBeDefined();
    });

    test("reports error when run not found", async () => {
      const result = await command(["cancel", "not-found"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Run "not-found" not found');
    });

    test("reports error when run has no steps", async () => {
      const result = await command(["cancel", "empty-steps"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("has no steps");
    });
  });

  // ---------------------------------------------------------------------------
  // Network errors
  // ---------------------------------------------------------------------------

  describe("network errors", () => {
    test("handles connection refused gracefully", async () => {
      const deadCommand = buildWorkflowCommand(makeScriptCtx("http://localhost:1"));
      const result = await deadCommand(["trigger", "test"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Error:");
    });
  });
});
