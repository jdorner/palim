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

/** A minimal valid DAG workflow JSON5 string. */
const VALID_WORKFLOW = `{
  "name": "deploy-app",
  "description": "Deploy the application",
  "trigger": { "type": "manual" },
  "steps": {
    "build": { "type": "agent", "prompt": "Build the application" }
  },
  "edges": []
}`;

/** A DAG workflow with two steps. */
const TWO_STEP_WORKFLOW = `{
  "name": "two-step",
  "trigger": { "type": "webhook", "ref": "github" },
  "steps": {
    "lint": { "type": "agent", "prompt": "Run linting" },
    "deploy": { "type": "agent", "prompt": "Deploy it" }
  },
  "edges": [
    { "from": "lint", "to": "deploy" }
  ]
}`;

/** A human task whose `reject` outcome has no path in the following case. */
const UNCOVERED_OUTCOME_WORKFLOW = `{
  "name": "offline-review",
  "trigger": { "type": "manual" },
  "steps": {
    "review": { "type": "humanTask", "title": "Review", "assignees": { "roles": ["portal-user"] } },
    "route": { "type": "case", "match": "{{steps.review.result.outcome}}", "paths": ["approve"] }
  },
  "edges": [{ "from": "review", "to": "route" }]
}`;

/** A DAG workflow with an edge referencing a non-existent step (structural error). */
const BAD_EDGE_WORKFLOW = `{
  "name": "bad-workflow",
  "trigger": { "type": "manual" },
  "steps": {
    "build": { "type": "agent", "prompt": "First step" }
  },
  "edges": [
    { "from": "build", "to": "nonexistent" }
  ]
}`;

/** Invalid JSON5 (missing required fields - empty steps). */
const INVALID_WORKFLOW = `{
  "name": "missing-stuff",
  "trigger": { "type": "manual" },
  "steps": {},
  "edges": []
}`;

/**
 * A structurally valid DAG that uses a custom step type ("sandbox-exec") whose
 * config the server rejects (the mock flags any step slug "bad-custom"). Passes
 * local schema/DAG checks (custom types match the generic step schema) but must
 * be blocked by the authoritative server-side validation.
 */
const BAD_CUSTOM_CONFIG_WORKFLOW = `{
  "name": "bad-custom-wf",
  "trigger": { "type": "manual" },
  "steps": {
    "bad-custom": { "type": "sandbox-exec", "command": ["mkdir -p outbox", "echo hi"] }
  },
  "edges": []
}`;

/** A workflow with additional properties not in the schema. */
const EXTRA_PROPS_WORKFLOW = `{
  "name": "extra-props",
  "trigger": { "type": "manual", "ref": "something", "extraTriggerProp": "should-fail" },
  "steps": {
    "build": { "type": "agent", "prompt": "Build it" }
  },
  "edges": []
}`;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("workflow command", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  let command: (args: string[], ctx: CommandContext) => Promise<ExecResult>;
  let received: Array<{ method: string; path: string; body?: unknown }>;
  /** What the mocked `GET /meta/load-errors` returns. */
  let loadErrors: unknown[];
  /** How often `GET /runs/:runId` was asked, by run ID. */
  let runPolls: Map<string, number>;

  beforeEach(() => {
    received = [];
    loadErrors = [];
    runPolls = new Map();

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

        if (reqPath === "/meta/load-errors" && req.method === "GET") {
          return Response.json(loadErrors);
        }

        // DELETE /runs/:runId - cancel a workflow run
        if (reqPath.match(/^\/runs\/[^/]+$/) && req.method === "DELETE") {
          const runId = reqPath.split("/")[2];
          if (runId === "not-found") {
            return Response.json({ error: "Not found" }, { status: 404 });
          }
          return Response.json({ runId, cancelled: ["job-001", "job-002"], total: 2 });
        }

        // POST /meta/validate - authoritative server-side validation.
        // Simulates a custom step-type config error for a step named
        // "bad-custom" so the CLI's blocking behavior can be exercised.
        if (reqPath === "/meta/validate" && req.method === "POST") {
          const def = body as { steps?: Record<string, { type?: string }> };
          const slugs = Object.keys(def?.steps ?? {});
          const errors = slugs
            .filter((slug) => slug === "bad-custom")
            .map(
              (slug) => `step "${slug}" (command): Invalid "sandbox-exec" step config: Expected string (at /command)`,
            );
          return Response.json({ valid: errors.length === 0, errors });
        }

        // POST /meta/analyze - advisory warnings for a posted definition.
        // "offline-*" workflows simulate an unavailable server; "server-warned"
        // gets one warning naming the posted steps.
        if (reqPath === "/meta/analyze" && req.method === "POST") {
          const def = body as { name?: string; steps?: Record<string, unknown> };
          if (def?.name?.startsWith("offline-")) return new Response("unavailable", { status: 503 });
          const warnings =
            def?.name === "server-warned"
              ? [{ stepSlug: "build", field: "prompt", message: `analyzed ${Object.keys(def.steps ?? {}).join(",")}` }]
              : [];
          return Response.json({ valid: true, warnings, errors: [] });
        }

        // GET /meta/step-types - engine and extension step type metadata
        if (reqPath === "/meta/step-types" && req.method === "GET") {
          return Response.json([
            {
              type: "iterator",
              label: "Iterator",
              description: "Runs the steps inside it once for each item of a list.",
              docs: 'Wire the body with `branch: "each"` edges, e.g. one request per item.',
              extensionName: "workflows",
              category: "control-flow",
            },
            {
              type: "http-request",
              label: "HTTP Request",
              description: "Sends an HTTP request.",
              docs: "Omit `headers` when you have none.",
              extensionName: "core-wf-steps",
              terminal: false,
              category: "action",
              configSchema: {
                type: "object",
                properties: {
                  url: { type: "string", description: "The URL to request" },
                  method: {
                    anyOf: [{ const: "GET" }, { const: "POST" }],
                    description: "HTTP method (defaults to POST)",
                  },
                },
                required: ["url"],
              },
              outputSchema: {
                type: "object",
                properties: { status: { type: "number", description: "HTTP status code" } },
              },
            },
            {
              type: "mail-fetch",
              label: "Mail Fetch",
              description: "Reads mails.",
              extensionName: "mail",
              category: "action",
              configSchema: {
                type: "object",
                properties: {
                  account: {
                    type: "string",
                    description: "Connected account",
                    dynamicItems: "mail-accounts",
                    availableItems: ["work", "home"],
                  },
                  label: { type: "string", dynamicItems: "mail-labels", availableItems: [] },
                  flag: { type: "string", availableItems: ["\\Seen", "\\Flagged"] },
                  search: {
                    type: "object",
                    description: "Search criteria",
                    properties: { seen: { type: "boolean", description: "Read state" } },
                  },
                  folders: { type: "array", items: { type: "string" }, description: "Folders to read" },
                },
              },
              outputSchema: {
                type: "object",
                required: ["messages"],
                properties: {
                  count: { type: "number", description: "Number of mails" },
                  messages: {
                    type: "array",
                    description: "The mails",
                    items: {
                      type: "object",
                      required: ["uid"],
                      properties: {
                        uid: { type: "number", description: "Mail id" },
                        subject: { anyOf: [{ type: "string" }, { type: "null" }], description: "Subject line" },
                        kind: { anyOf: [{ const: "plain" }, { const: "html" }, { type: "null" }] },
                        from: {
                          type: "array",
                          description: "Senders",
                          items: {
                            type: "object",
                            properties: {
                              address: { type: "string", description: "Mail address" },
                              org: {
                                type: "object",
                                description: "Organisation",
                                properties: { name: { type: "string", description: "Too deep to show" } },
                              },
                            },
                          },
                        },
                        sender: {
                          anyOf: [{ type: "object", properties: { name: { type: "string" } } }, { type: "null" }],
                        },
                      },
                    },
                  },
                },
              },
            },
            {
              type: "fail",
              label: "Fail",
              extensionName: "core-wf-steps",
              terminal: true,
              category: "control-flow",
              configSchema: {
                type: "object",
                properties: { message: { type: "string", description: "Error message to fail with" } },
              },
            },
          ]);
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
          const runId = reqPath.split("/")[2] ?? "";
          const polls = (runPolls.get(runId) ?? 0) + 1;
          runPolls.set(runId, polls);
          const build = { slug: "build", type: "agent", status: "completed", jobId: "job-001" };
          if (runId === "run-slow") {
            const status = polls < 3 ? "running" : "completed";
            return Response.json({ runId, workflowName: "deploy-app", status, steps: [build] });
          }
          if (runId === "run-stuck") {
            const running = { slug: "deploy", type: "agent", status: "running", jobId: "job-002" };
            return Response.json({ runId, workflowName: "deploy-app", status: "running", steps: [build, running] });
          }
          if (runId === "run-fail") {
            return Response.json({
              runId,
              workflowName: "deploy-app",
              status: "failed",
              failureReason: "deploy: HTTP 500",
              steps: [build],
            });
          }
          if (runId === "run-waiting") {
            return Response.json({
              runId,
              workflowName: "offline-review",
              status: "waiting-signal",
              steps: [
                build,
                {
                  slug: "review",
                  type: "humanTask",
                  status: "waiting-signal",
                  jobId: "",
                  humanTask: { title: "Review", assignees: { users: ["anna"], roles: ["portal-user"] } },
                },
                { slug: "gate", type: "waitFor", status: "waiting-signal", jobId: "", waitEvent: "invoice.paid" },
              ],
            });
          }
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

    test("marks files the server did not load, with the reason", async () => {
      const ctx = await makeCtxWithFiles({
        "deploy-app.json5": VALID_WORKFLOW,
        "loose.json5": TWO_STEP_WORKFLOW,
      });
      loadErrors = [{ file: "loose.json5", name: "two-step", error: 'Step "a" is not connected to any other step' }];

      const result = await command(["list"], ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        'two-step (loose.json5) - NOT LOADED: Step "a" is not connected to any other step',
      );
      expect(result.stdout).toContain("deploy-app (deploy-app.json5) - 1 steps");
      expect(result.stdout).toContain("`workflow validate <name>` checks a fix");
    });

    test("without load errors there is no NOT LOADED hint", async () => {
      const ctx = await makeCtxWithFiles({ "deploy-app.json5": VALID_WORKFLOW });
      const result = await command(["list"], ctx);
      expect(result.stdout).not.toContain("NOT LOADED");
    });

    test("handles parse errors gracefully", async () => {
      const ctx = await makeCtxWithFiles({ "broken.json5": "{{{{invalid json5" });

      const result = await command(["list"], ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("broken.json5");
    });
  });

  // ---------------------------------------------------------------------------
  // step-types
  // ---------------------------------------------------------------------------

  describe("step-types", () => {
    test("lists engine and extension step types, one line each, grouped by owner", async () => {
      const result = await command(["step-types"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Available workflow step types (4):");
      expect(result.stdout).toContain("Engine (agent and control flow):");
      expect(result.stdout).toMatch(/iterator\s+Runs the steps inside it once for each item of a list\./);
      expect(result.stdout).toContain("From extension core-wf-steps:");
      expect(result.stdout).toMatch(/http-request\s+Sends an HTTP request\./);
      // Falls back to the label without a description; terminal types are flagged.
      expect(result.stdout).toMatch(/fail\s+Fail \[terminal\]/);
      // Engine types come before extension types.
      expect(result.stdout.indexOf("iterator")).toBeLessThan(result.stdout.indexOf("http-request"));
      // The index stays compact: no fields or docs.
      expect(result.stdout).not.toContain("The URL to request");
      expect(result.stdout).not.toContain("Omit `headers`");
      expect(result.stdout).toContain("workflow step-types <type>");

      const req = received.find((r) => r.path === "/meta/step-types");
      expect(req).toBeDefined();
      expect(req!.method).toBe("GET");
    });

    test("shows one step type in full: fields, result, and docs", async () => {
      const result = await command(["step-types", "http-request"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("http-request - HTTP Request (from core-wf-steps) [action]");
      expect(result.stdout).toContain("Config fields:");
      expect(result.stdout).toContain("- url (string, required): The URL to request");
      expect(result.stdout).toContain('- method ("GET" | "POST"): HTTP method (defaults to POST)');
      expect(result.stdout).toContain("- status (number): HTTP status code");
      expect(result.stdout).toContain("Omit `headers` when you have none.");
    });

    test("leaves a step type without nested fields unchanged", async () => {
      const result = await command(["step-types", "http-request"], makeCtx());
      expect(result.stdout).toBe(
        [
          "http-request - HTTP Request (from core-wf-steps) [action]",
          "Sends an HTTP request.",
          "",
          "Config fields:",
          "  - url (string, required): The URL to request",
          '  - method ("GET" | "POST"): HTTP method (defaults to POST)',
          "",
          "Result fields ({{steps.<slug>.result.<field>}}):",
          "  - status (number): HTTP status code",
          "",
          "Omit `headers` when you have none.",
        ].join("\n"),
      );
    });

    test("shows the fields of a nested config object, and leaves an array of scalars as one line", async () => {
      const { stdout } = await command(["step-types", "mail-fetch"], makeCtx());
      expect(stdout).toContain(
        ["  - search (object): Search criteria", "      - seen (boolean): Read state"].join("\n"),
      );
      expect(stdout).toContain("  - folders (array of string): Folders to read\n\nResult fields");
    });

    test("lists the live values of a dynamicItems field, but not a static suggestion list", async () => {
      const { stdout } = await command(["step-types", "mail-fetch"], makeCtx());
      expect(stdout).toContain(
        ["  - account (string): Connected account", '      available now: "work", "home"'].join("\n"),
      );
      expect(stdout).toContain(["  - label (string)", "      available now: none (nothing set up yet)"].join("\n"));
      expect(stdout).toContain("  - flag (string)\n  - search");
    });

    test("shows the item fields of an array of objects, with required flags", async () => {
      const { stdout } = await command(["step-types", "mail-fetch"], makeCtx());
      expect(stdout).toContain(
        [
          "  - messages (array of object, required): The mails",
          "      each item:",
          "      - uid (number, required): Mail id",
        ].join("\n"),
      );
      expect(stdout).toContain(
        [
          "      - from (array of object): Senders",
          "          each item:",
          "          - address (string): Mail address",
        ].join("\n"),
      );
    });

    test("renders unions of types, also mixed with literals, and the fields of an object-or-null", async () => {
      const { stdout } = await command(["step-types", "mail-fetch"], makeCtx());
      expect(stdout).toContain("      - subject (string | null): Subject line");
      expect(stdout).toContain('      - kind ("plain" | "html" | null)');
      expect(stdout).toContain(["      - sender (object | null)", "          - name (string)"].join("\n"));
    });

    test("cuts nested fields below three levels with an ellipsis", async () => {
      const { stdout } = await command(["step-types", "mail-fetch"], makeCtx());
      expect(stdout).toContain(["          - org (object): Organisation", "              ..."].join("\n"));
      expect(stdout).not.toContain("Too deep to show");
    });

    test("says how to read item fields inside an iterator, only for arrays of objects", async () => {
      const { stdout } = await command(["step-types", "mail-fetch"], makeCtx());
      expect(stdout).toContain('Inside an iterator over messages with as: "item", read these as {{item.<field>}}.');
      expect(stdout.match(/Inside an iterator over/g)).toHaveLength(1);
      const plain = await command(["step-types", "http-request"], makeCtx());
      expect(plain.stdout).not.toContain("Inside an iterator");
    });

    test("shows an engine step type's docs", async () => {
      const result = await command(["step-types", "iterator"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("iterator - Iterator (from workflows) [control-flow]");
      expect(result.stdout).toContain('Wire the body with `branch: "each"` edges');
      expect(result.stdout).not.toContain("Config fields:");
    });

    test("rejects an unknown step type and suggests similar ones", async () => {
      const result = await command(["step-types", "http"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unknown step type "http"');
      expect(result.stderr).toContain("Similar: http-request");
    });

    test("searches summaries, fields, and docs, ranking summary matches first", async () => {
      const byDocs = await command(["step-types", "--search", "headers"], makeCtx());
      expect(byDocs.exitCode).toBe(0);
      expect(byDocs.stdout).toContain('Step types matching "headers"');
      expect(byDocs.stdout).toContain("http-request");
      expect(byDocs.stdout).not.toMatch(/iterator\s/);

      // Every term must match.
      const allTerms = await command(["step-types", "-s", "request url"], makeCtx());
      expect(allTerms.stdout).toContain("http-request");
      expect(allTerms.stdout).not.toMatch(/iterator\s/);

      // "request" is in http-request's summary but only in the iterator's docs:
      // a flat list, summary match first, each line naming its owner.
      const ranked = await command(["step-types", "--search", "request"], makeCtx());
      expect(ranked.stdout).toMatch(/http-request\s+Sends an HTTP request\. \(core-wf-steps\)/);
      expect(ranked.stdout).toMatch(/iterator\s+.*\(workflows\)/);
      expect(ranked.stdout.indexOf("http-request")).toBeLessThan(ranked.stdout.indexOf("iterator"));
    });

    test("reports when no step type matches the search", async () => {
      const result = await command(["step-types", "--search", "nonexistent"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No step types match "nonexistent"');
    });

    test("reports an error when the endpoint fails", async () => {
      const deadCommand = buildWorkflowCommand(makeScriptCtx("http://localhost:1"));
      const result = await deadCommand(["step-types"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Error:");
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

    test("--draft marks the written workflow as a draft", async () => {
      const ctx = makeCtx();
      const result = await command(["write", "--draft", "deploy-app", VALID_WORKFLOW], ctx);
      expect(result.exitCode).toBe(0);
      const content = await ctx.fs.readFile(ctx.fs.resolvePath(WORKFLOWS_DIR, "deploy-app.json5"));
      expect(Bun.JSON5.parse(content)).toStrictEqual({ ...(Bun.JSON5.parse(VALID_WORKFLOW) as object), draft: true });
    });

    test("without --draft, a draft in the content is kept and none is added", async () => {
      const ctx = makeCtx();
      const asDraft = JSON.stringify({ ...(Bun.JSON5.parse(VALID_WORKFLOW) as object), draft: true });
      expect((await command(["write", "deploy-app", asDraft], ctx)).exitCode).toBe(0);
      const kept = Bun.JSON5.parse(await ctx.fs.readFile(ctx.fs.resolvePath(WORKFLOWS_DIR, "deploy-app.json5")));
      expect(kept).toHaveProperty("draft", true);

      const other = makeCtx();
      expect((await command(["write", "deploy-app", VALID_WORKFLOW], other)).exitCode).toBe(0);
      const plain = Bun.JSON5.parse(await other.fs.readFile(other.fs.resolvePath(WORKFLOWS_DIR, "deploy-app.json5")));
      expect(plain).not.toHaveProperty("draft");
    });

    test("rewriting an existing draft without --draft keeps it a draft", async () => {
      const ctx = makeCtx();
      expect((await command(["write", "--draft", "deploy-app", VALID_WORKFLOW], ctx)).exitCode).toBe(0);
      const filePath = ctx.fs.resolvePath(WORKFLOWS_DIR, "deploy-app.json5");

      const plain = await command(["write", "deploy-app", VALID_WORKFLOW], ctx);
      expect(plain.exitCode).toBe(0);
      expect(plain.stdout).toContain("stays one");
      expect(Bun.JSON5.parse(await ctx.fs.readFile(filePath))).toHaveProperty("draft", true);

      const explicit = JSON.stringify({ ...(Bun.JSON5.parse(VALID_WORKFLOW) as object), draft: false });
      expect((await command(["write", "deploy-app", explicit], ctx)).exitCode).toBe(0);
      expect(Bun.JSON5.parse(await ctx.fs.readFile(filePath))).toHaveProperty("draft", true);
    });

    test("list marks drafts", async () => {
      const draft = JSON.stringify({ ...(Bun.JSON5.parse(VALID_WORKFLOW) as object), draft: true });
      const ctx = await makeCtxWithFiles({ "deploy-app.json5": draft });
      expect((await command(["list"], ctx)).stdout).toContain("[draft]");
    });

    test("rejects invalid workflow (schema validation)", async () => {
      const result = await command(["write", "bad", INVALID_WORKFLOW], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Validation failed");
    });

    test("rejects workflow with an edge referencing a non-existent step", async () => {
      const result = await command(["write", "bad", BAD_EDGE_WORKFLOW], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("DAG validation failed");
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

    test("blocks write on invalid custom step-type config (server-side) and does not write the file", async () => {
      const ctx = makeCtx();
      const result = await command(["write", "bad-custom-wf", BAD_CUSTOM_CONFIG_WORKFLOW], ctx);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Validation failed");
      expect(result.stderr).toContain("sandbox-exec");
      expect(result.stderr).toContain("command");

      // The invalid workflow must NOT have been persisted.
      const filePath = ctx.fs.resolvePath(WORKFLOWS_DIR, "bad-custom-wf.json5");
      expect(await ctx.fs.exists(filePath)).toBe(false);

      // The CLI called the authoritative validation endpoint.
      expect(received.some((r) => r.path === "/meta/validate" && r.method === "POST")).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // validate
  // ---------------------------------------------------------------------------

  describe("validate", () => {
    test("reports the server's warnings for the definition on disk", async () => {
      const ctx = await makeCtxWithFiles({
        "server-warned.json5": VALID_WORKFLOW.replace('"deploy-app"', '"server-warned"'),
      });

      const result = await command(["validate", "server-warned"], ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Warnings:\n  [build.prompt] analyzed build");
      expect(received.some((r) => r.method === "POST" && r.path === "/meta/analyze")).toBe(true);
      expect(received.some((r) => r.method === "GET" && r.path === "/server-warned")).toBe(false);
    });

    test("reports outcome coverage locally when the server is unavailable", async () => {
      const ctx = await makeCtxWithFiles({ "offline-review.json5": UNCOVERED_OUTCOME_WORKFLOW });

      const result = await command(["validate", "offline-review"], ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        '[route.paths] Outcome "reject" of "review" has no path in "route": choosing it fails the run',
      );
    });

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

    test("reports edges referencing non-existent steps", async () => {
      const ctx = await makeCtxWithFiles({ "bad.json5": BAD_EDGE_WORKFLOW });

      const result = await command(["validate", "bad"], ctx);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("DAG validation failed");
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

    test("reports invalid custom step-type config via server-side validation", async () => {
      const ctx = await makeCtxWithFiles({ "bad-custom-wf.json5": BAD_CUSTOM_CONFIG_WORKFLOW });

      const result = await command(["validate", "bad-custom-wf"], ctx);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Validation failed");
      expect(result.stderr).toContain("command");
    });
  });

  // ---------------------------------------------------------------------------
  // outline and editing commands
  // ---------------------------------------------------------------------------

  describe("outline and editing commands", () => {
    /** A draft: review (human task) -> route (case) -> notify on approve. */
    const REVIEW_DRAFT = JSON.stringify({
      name: "review-flow",
      draft: true,
      description: "Review",
      trigger: { type: "manual" },
      steps: {
        review: { type: "humanTask", title: "Review", assignees: { roles: ["portal-user"] } },
        route: { type: "case", match: "{{steps.review.result.outcome}}", paths: ["approve", "reject"] },
        notify: { type: "agent", prompt: "Tell them" },
      },
      edges: [
        { from: "review", to: "route" },
        { from: "route", to: "notify", branch: "approve" },
      ],
    });
    const FILE = `${WORKFLOWS_DIR}/review-flow.json5`;

    async function load(ctx: CommandContext): Promise<Record<string, any>> {
      return Bun.JSON5.parse(await ctx.fs.readFile(FILE)) as Record<string, any>;
    }

    test("outline prints the steps without writing", async () => {
      const ctx = await makeCtxWithFiles({ "review-flow.json5": REVIEW_DRAFT });
      const result = await command(["outline", "review-flow"], ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toStartWith("review-flow (draft) · trigger: manual · inputs: none");
      expect(result.stdout).toContain("route   case       approve -> notify | reject -> (end)");
      expect(await ctx.fs.readFile(FILE)).toBe(REVIEW_DRAFT);
    });

    test("add-loop wraps the steps, prints the outline and what is left to change", async () => {
      const LINEAR = JSON.stringify({
        name: "tagging",
        draft: true,
        trigger: { type: "manual" },
        steps: {
          fetch: { type: "agent", prompt: "Fetch" },
          classify: { type: "agent", prompt: "Classify {{ steps.fetch.result.messages }}" },
          tag: { type: "agent", prompt: 'Tag {{steps.classify.result.label}} and {{steps["classify"].result}}' },
          notify: {
            type: "agent",
            prompt: "Report {{steps.fetch.result.messagesCount}} {{steps.fetch.result.messages.length}}",
          },
          other: { type: "agent", prompt: "Unrelated {{steps.classify-more.result}}" },
          "classify-more": { type: "agent", prompt: "x" },
        },
        edges: [
          { from: "fetch", to: "classify" },
          { from: "classify", to: "tag" },
          { from: "tag", to: "notify" },
          { from: "fetch", to: "classify-more" },
          { from: "classify-more", to: "other" },
        ],
      });
      const file = `${WORKFLOWS_DIR}/tagging.json5`;
      const ctx = await makeCtxWithFiles({ "tagging.json5": LINEAR });
      const result = await command(
        [
          "add-loop",
          "tagging",
          "each-mail",
          "--over",
          "{{steps.fetch.result.messages}}",
          "--as",
          "mail",
          "--from",
          "classify",
          "--to",
          "classify",
        ],
        ctx,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Iterator "each-mail" and aggregator "each-mail-done" added around "classify".');
      expect(result.stdout).toMatch(/each-mail\s+iterator/);
      expect(result.stdout).toEndWith(
        [
          "Loop added. Now change these steps:",
          '- Replace {{steps.fetch.result.messages}} in "classify" with {{mail}} or {{mail.<field>}}.',
          '- "tag" is after the loop but reads "classify". Move it into the loop, or read {{steps.each-mail-done.result.results}}.',
          "- Results of all passes: {{steps.each-mail-done.result.results}}.",
        ].join("\n"),
      );
      const written = Bun.JSON5.parse(await ctx.fs.readFile(file)) as Record<string, any>;
      expect(written.draft).toBe(true);
      expect(written.edges).toContainEqual({ from: "each-mail", to: "classify", branch: "each" });

      // Refused: nothing changes on disk.
      const before = await ctx.fs.readFile(file);
      const refused = await command(
        [
          "add-loop",
          "tagging",
          "again",
          "--over",
          "{{steps.fetch.result.messages}}",
          "--from",
          "classify",
          "--to",
          "classify",
        ],
        ctx,
      );
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain('already inside the loop "each-mail"');
      expect(refused.stderr).toContain("Nothing was written.");
      expect(await ctx.fs.readFile(file)).toBe(before);

      const incomplete = await command(["add-loop", "tagging", "x", "--from", "fetch"], ctx);
      expect(incomplete.exitCode).toBe(1);
      expect(incomplete.stderr).toContain("add-loop needs --over, --to");
    });

    test("outline reports a missing workflow", async () => {
      const result = await command(["outline", "nope"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Workflow "nope" not found');
    });

    test("set-step --after --branch adds the step and the branch edge, and keeps the draft", async () => {
      const ctx = await makeCtxWithFiles({ "review-flow.json5": REVIEW_DRAFT });
      const result = await command(
        [
          "set-step",
          "review-flow",
          "rejected",
          '{ type: "agent", prompt: "Say no" }',
          "--after",
          "route",
          "--branch",
          "reject",
        ],
        ctx,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Step "rejected" created.');
      expect(result.stdout).toContain('Edge "route" -> "rejected" (branch "reject") added.');
      expect(result.stdout).toContain("approve -> notify | reject -> rejected");
      expect(result.stdout).not.toContain("is active");
      const saved = await load(ctx);
      expect(saved.draft).toBe(true);
      expect(saved.steps.rejected).toEqual({ type: "agent", prompt: "Say no" });
      expect(saved.edges).toContainEqual({ from: "route", to: "rejected", branch: "reject" });
      // Untouched parts are carried over.
      expect(saved.steps.review).toEqual(JSON.parse(REVIEW_DRAFT).steps.review);
      expect(saved.description).toBe("Review");
    });

    test("set-step --after without --branch links a plain step", async () => {
      const ctx = await makeCtxWithFiles({ "review-flow.json5": REVIEW_DRAFT });
      const result = await command(["set-step", "review-flow", "log", '{ type: "noop" }', "--after", "notify"], ctx);
      expect(result.exitCode).toBe(0);
      expect((await load(ctx)).edges).toContainEqual({ from: "notify", to: "log" });
    });

    test("set-step replaces an existing step; --after with an existing edge is noted, not duplicated", async () => {
      const ctx = await makeCtxWithFiles({ "review-flow.json5": REVIEW_DRAFT });
      const result = await command(
        [
          "set-step",
          "review-flow",
          "notify",
          '{ type: "agent", prompt: "New" }',
          "--after",
          "route",
          "--branch",
          "approve",
        ],
        ctx,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Step "notify" replaced.');
      expect(result.stdout).toContain("already exists; not added again");
      const saved = await load(ctx);
      expect(saved.steps.notify.prompt).toBe("New");
      expect(saved.edges).toHaveLength(2);
    });

    test("set-step reads the step from --file", async () => {
      const ctx = await makeCtxWithFiles({ "review-flow.json5": REVIEW_DRAFT });
      await ctx.fs.writeFile(`${CWD}/step.json5`, '{ type: "agent", prompt: "line 1\\nline \'2\'" }');
      const result = await command(["set-step", "review-flow", "notify", "--file", "step.json5"], ctx);
      expect(result.exitCode).toBe(0);
      expect((await load(ctx)).steps.notify.prompt).toBe("line 1\nline '2'");
    });

    test("set-step refuses both content and --file, and neither", async () => {
      const ctx = await makeCtxWithFiles({ "review-flow.json5": REVIEW_DRAFT });
      await ctx.fs.writeFile(`${CWD}/step.json5`, '{ type: "noop" }');
      const both = await command(
        ["set-step", "review-flow", "notify", '{ type: "noop" }', "--file", "step.json5"],
        ctx,
      );
      expect(both.exitCode).toBe(1);
      expect(both.stderr).toContain("not both");
      const neither = await command(["set-step", "review-flow", "notify"], ctx);
      expect(neither.exitCode).toBe(1);
      expect(neither.stderr).toContain("Missing step");
      expect(await ctx.fs.readFile(FILE)).toBe(REVIEW_DRAFT);
    });

    test("a refused edit writes nothing and says what to do first", async () => {
      const ctx = await makeCtxWithFiles({ "review-flow.json5": REVIEW_DRAFT });
      // A new step without --after is not connected.
      const orphan = await command(["set-step", "review-flow", "lonely", '{ type: "noop" }'], ctx);
      expect(orphan.exitCode).toBe(1);
      expect(orphan.stderr).toContain("DAG validation failed");
      expect(orphan.stderr).toContain('--after "<slug>"');
      expect(orphan.stderr).toContain("Nothing was written.");

      // Renaming a case path while an edge still uses the old branch.
      const rename = await command(
        [
          "set-step",
          "review-flow",
          "route",
          '{ type: "case", match: "{{steps.review.result.outcome}}", paths: ["ok", "reject"] }',
        ],
        ctx,
      );
      expect(rename.exitCode).toBe(1);
      expect(rename.stderr).toContain("new path next to the old one");
      expect(await ctx.fs.readFile(FILE)).toBe(REVIEW_DRAFT);
    });

    test("a case path is renamed in the order the hint gives, each step valid", async () => {
      const ctx = await makeCtxWithFiles({ "review-flow.json5": REVIEW_DRAFT });
      const match = "{{steps.review.result.outcome}}";
      const steps = [
        ["set-step", "review-flow", "route", `{ type: "case", match: "${match}", paths: ["approve", "ok", "reject"] }`],
        ["add-edge", "review-flow", "route", "notify", "--branch", "ok"],
        ["remove-edge", "review-flow", "route", "notify", "--branch", "approve"],
        ["set-step", "review-flow", "route", `{ type: "case", match: "${match}", paths: ["ok", "reject"] }`],
      ];
      for (const argv of steps) {
        const result = await command(argv, ctx);
        expect(result.stderr).toBe("");
        expect(result.exitCode).toBe(0);
        expect(result.stdout).not.toContain("no incoming edge");
      }
      const saved = await load(ctx);
      expect(saved.steps.route.paths).toEqual(["ok", "reject"]);
      expect(saved.edges).toContainEqual({ from: "route", to: "notify", branch: "ok" });
      expect(saved.edges).toHaveLength(2);
    });

    test("an edit that leaves an existing step without incoming edges says it now runs at the start", async () => {
      const ctx = await makeCtxWithFiles({ "review-flow.json5": REVIEW_DRAFT });
      expect(
        (await command(["set-step", "review-flow", "log", '{ type: "noop" }', "--after", "notify"], ctx)).exitCode,
      ).toBe(0);
      const result = await command(["remove-edge", "review-flow", "route", "notify"], ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        'Note: step "notify" has no incoming edge now, so it runs at the start of every run.',
      );
    });

    test("remove-step removes the step and its edges", async () => {
      const ctx = await makeCtxWithFiles({ "review-flow.json5": REVIEW_DRAFT });
      const result = await command(["remove-step", "review-flow", "notify"], ctx);
      expect(result.exitCode).toBe(0);
      const saved = await load(ctx);
      expect(saved.steps.notify).toBeUndefined();
      expect(saved.edges).toEqual([{ from: "review", to: "route" }]);
      expect(saved.draft).toBe(true);
    });

    test("remove-step of an unknown step fails", async () => {
      const ctx = await makeCtxWithFiles({ "review-flow.json5": REVIEW_DRAFT });
      const result = await command(["remove-step", "review-flow", "nope"], ctx);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unknown step "nope"');
    });

    test("add-edge and remove-edge", async () => {
      const ctx = await makeCtxWithFiles({ "review-flow.json5": REVIEW_DRAFT });
      const added = await command(["add-edge", "review-flow", "route", "notify", "--branch", "reject"], ctx);
      expect(added.exitCode).toBe(0);
      expect(added.stdout).toContain("approve -> notify | reject -> notify");

      const removed = await command(["remove-edge", "review-flow", "route", "notify", "--branch", "approve"], ctx);
      expect(removed.exitCode).toBe(0);
      expect((await load(ctx)).edges).toEqual([
        { from: "review", to: "route" },
        { from: "route", to: "notify", branch: "reject" },
      ]);
    });

    test("add-edge from a case without --branch is refused", async () => {
      const ctx = await makeCtxWithFiles({ "review-flow.json5": REVIEW_DRAFT });
      const result = await command(["add-edge", "review-flow", "route", "review"], ctx);
      expect(result.exitCode).toBe(1);
      expect(await ctx.fs.readFile(FILE)).toBe(REVIEW_DRAFT);
    });

    test("set-meta changes description and refuses draft", async () => {
      const ctx = await makeCtxWithFiles({ "review-flow.json5": REVIEW_DRAFT });
      const result = await command(["set-meta", "review-flow", '{ description: "New", group: "Demo" }'], ctx);
      expect(result.exitCode).toBe(0);
      expect(await load(ctx)).toMatchObject({ description: "New", group: "Demo", draft: true });

      const refused = await command(["set-meta", "review-flow", "{ draft: false }"], ctx);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain('Cannot set "draft"');
      expect((await load(ctx)).draft).toBe(true);
    });

    test("an edit of an active workflow says the change is live", async () => {
      const active = JSON.stringify({ ...JSON.parse(REVIEW_DRAFT), draft: undefined });
      const ctx = await makeCtxWithFiles({ "review-flow.json5": active });
      const result = await command(["set-meta", "review-flow", '{ description: "x" }'], ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("The workflow is active: this change is live.");
    });

    test("write reads the content from --file and refuses both sources", async () => {
      const ctx = makeCtx();
      await ctx.fs.writeFile(`${CWD}/wf.json5`, VALID_WORKFLOW);
      const result = await command(["write", "deploy-app", "--file", "wf.json5"], ctx);
      expect(result.exitCode).toBe(0);
      const saved = await ctx.fs.readFile(ctx.fs.resolvePath(WORKFLOWS_DIR, "deploy-app.json5"));
      expect(Bun.JSON5.parse(saved)).toStrictEqual(Bun.JSON5.parse(VALID_WORKFLOW));

      const both = await command(["write", "deploy-app", VALID_WORKFLOW, "--file", "wf.json5"], ctx);
      expect(both.exitCode).toBe(1);
      expect(both.stderr).toContain("not both");
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
  // wait
  // ---------------------------------------------------------------------------

  describe("wait", () => {
    /** The command with a short poll interval, so the tests do not sleep long. */
    const fastCommand = () => buildWorkflowCommand(makeScriptCtx(baseUrl), { pollIntervalMs: 10 });

    test("polls until the run completes, then shows its logs", async () => {
      const result = await fastCommand()(["wait", "run-slow"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Run run-slow of "deploy-app" completed.');
      expect(result.stdout).toContain("Build done");
      expect(runPolls.get("run-slow")).toBe(3);
    });

    test("a failed run exits 1 with the reason and the logs", async () => {
      const result = await fastCommand()(["wait", "run-fail"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("failed.");
      expect(result.stdout).toContain("Reason: deploy: HTTP 500");
      expect(result.stdout).toContain("Run: run-fail");
    });

    test("returns at once when the run waits for a human task or a signal", async () => {
      const result = await fastCommand()(["wait", "run-waiting"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("is waiting for input");
      expect(result.stdout).toContain('review: human task "Review" assigned to anna, role portal-user');
      expect(result.stdout).toContain('gate: signal "invoice.paid"');
      expect(result.stdout).not.toContain("build:");
      expect(runPolls.get("run-waiting")).toBe(1);
    });

    test("gives up after the timeout and prints the step statuses", async () => {
      const result = await fastCommand()(["wait", "run-stuck", "--timeout", "0.1"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("is still running after 0.1s");
      expect(result.stdout).toContain("deploy [running]");
      expect(result.stdout).toContain('workflow wait "run-stuck"');
      expect(runPolls.get("run-stuck")).toBeGreaterThan(1);
    });

    test("stops waiting when the command is cancelled", async () => {
      const controller = new AbortController();
      const ctx = { ...makeCtx(), signal: controller.signal } as CommandContext;
      const slow = buildWorkflowCommand(makeScriptCtx(baseUrl), { pollIntervalMs: 60_000 });
      const pending = slow(["wait", "run-stuck"], ctx);
      setTimeout(() => controller.abort(), 20);
      const result = await pending;
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("is still running");
    });

    test("rejects a bad --timeout", async () => {
      for (const timeout of ["abc", "0", "-5", "5000"]) {
        const result = await fastCommand()(["wait", "run-slow", "--timeout", timeout], makeCtx());
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("--timeout must be");
      }
      expect(runPolls.has("run-slow")).toBe(false);
    });

    test("reports error when run not found", async () => {
      const result = await fastCommand()(["wait", "not-found"], makeCtx());
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
