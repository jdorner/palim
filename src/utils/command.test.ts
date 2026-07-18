/**
 * Tests for the `createCommand` utility - specifically the named options feature.
 * Positional arg parsing is already covered by downstream script tests.
 */

import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import type { CommandContext } from "just-bash";
import { EMPTY_BYTES, InMemoryFs } from "just-bash";
import { createCommand } from "./command";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(): CommandContext {
  return { fs: new InMemoryFs(), cwd: "/home/user/work", env: new Map(), stdin: EMPTY_BYTES };
}

/** Creates a simple command with one subcommand for testing options. */
function buildTestCommand(sub: Parameters<typeof createCommand>[0]["subcommands"][0]) {
  return createCommand({ name: "test", description: "Test command", subcommands: [sub] });
}

// ---------------------------------------------------------------------------
// Named options
// ---------------------------------------------------------------------------

describe("createCommand options", () => {
  describe("basic value options", () => {
    const cmd = buildTestCommand({
      name: "run",
      description: "Run something",
      args: [{ name: "target" }],
      options: [
        { name: "timeout", short: "t", description: "Timeout in ms" },
        { name: "output", short: "o", description: "Output path" },
      ],
      handler: async (_ctx, args) => ({
        exitCode: 0,
        stdout: JSON.stringify({
          target: args.get("target"),
          timeout: args.option("timeout"),
          output: args.option("output"),
        }),
        stderr: "",
      }),
    });

    test("parses --name value syntax", async () => {
      const result = await cmd(["run", "--timeout", "5000", "myTarget"], makeCtx());
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.timeout).toBe("5000");
      expect(data.target).toBe("myTarget");
    });

    test("parses --name=value syntax", async () => {
      const result = await cmd(["run", "--timeout=3000", "myTarget"], makeCtx());
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.timeout).toBe("3000");
      expect(data.target).toBe("myTarget");
    });

    test("parses -n value short syntax", async () => {
      const result = await cmd(["run", "-t", "2000", "myTarget"], makeCtx());
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.timeout).toBe("2000");
      expect(data.target).toBe("myTarget");
    });

    test("parses -n=value short syntax", async () => {
      const result = await cmd(["run", "-t=1500", "myTarget"], makeCtx());
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.timeout).toBe("1500");
      expect(data.target).toBe("myTarget");
    });

    test("options can appear after positional args", async () => {
      const result = await cmd(["run", "myTarget", "--timeout", "4000"], makeCtx());
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.timeout).toBe("4000");
      expect(data.target).toBe("myTarget");
    });

    test("options can be interspersed with positional args", async () => {
      const result = await cmd(["run", "--output", "/tmp/out", "myTarget", "-t", "100"], makeCtx());
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.timeout).toBe("100");
      expect(data.output).toBe("/tmp/out");
      expect(data.target).toBe("myTarget");
    });

    test("missing optional option returns empty string", async () => {
      const result = await cmd(["run", "myTarget"], makeCtx());
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.timeout).toBe("");
      expect(data.output).toBe("");
      expect(data.target).toBe("myTarget");
    });
  });

  describe("boolean flags", () => {
    const cmd = buildTestCommand({
      name: "run",
      description: "Run something",
      args: [{ name: "target" }],
      options: [
        { name: "verbose", short: "v", boolean: true, description: "Verbose output" },
        { name: "dry-run", boolean: true, description: "Dry run mode" },
      ],
      handler: async (_ctx, args) => ({
        exitCode: 0,
        stdout: JSON.stringify({
          target: args.get("target"),
          verbose: args.flag("verbose"),
          dryRun: args.flag("dry-run"),
        }),
        stderr: "",
      }),
    });

    test("boolean flag is false when not provided", async () => {
      const result = await cmd(["run", "myTarget"], makeCtx());
      const data = JSON.parse(result.stdout);
      expect(data.verbose).toBe(false);
      expect(data.dryRun).toBe(false);
    });

    test("boolean flag is true when provided (long)", async () => {
      const result = await cmd(["run", "--verbose", "myTarget"], makeCtx());
      const data = JSON.parse(result.stdout);
      expect(data.verbose).toBe(true);
    });

    test("boolean flag is true when provided (short)", async () => {
      const result = await cmd(["run", "-v", "myTarget"], makeCtx());
      const data = JSON.parse(result.stdout);
      expect(data.verbose).toBe(true);
    });

    test("boolean flag does not consume next arg as value", async () => {
      const result = await cmd(["run", "--verbose", "--dry-run", "myTarget"], makeCtx());
      const data = JSON.parse(result.stdout);
      expect(data.verbose).toBe(true);
      expect(data.dryRun).toBe(true);
      expect(data.target).toBe("myTarget");
    });
  });

  describe("repeatable options", () => {
    const cmd = buildTestCommand({
      name: "fetch",
      description: "Fetch a URL",
      args: [{ name: "url" }],
      options: [{ name: "header", short: "H", multiple: true, description: "HTTP header" }],
      handler: async (_ctx, args) => ({
        exitCode: 0,
        stdout: JSON.stringify({
          url: args.get("url"),
          headers: args.options("header"),
        }),
        stderr: "",
      }),
    });

    test("collects multiple values for repeatable option", async () => {
      const result = await cmd(
        ["fetch", "-H", "Authorization: Bearer tok", "-H", "X-Custom: val", "https://example.com"],
        makeCtx(),
      );
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.headers).toEqual(["Authorization: Bearer tok", "X-Custom: val"]);
      expect(data.url).toBe("https://example.com");
    });

    test("returns empty array when repeatable option not provided", async () => {
      const result = await cmd(["fetch", "https://example.com"], makeCtx());
      const data = JSON.parse(result.stdout);
      expect(data.headers).toEqual([]);
    });

    test("single value still returns array", async () => {
      const result = await cmd(["fetch", "--header", "X-Key: abc", "https://example.com"], makeCtx());
      const data = JSON.parse(result.stdout);
      expect(data.headers).toEqual(["X-Key: abc"]);
    });
  });

  describe("default values", () => {
    const cmd = buildTestCommand({
      name: "run",
      description: "Run something",
      args: [{ name: "target" }],
      options: [
        { name: "format", short: "f", defaultValue: "json", description: "Output format" },
        { name: "timeout", short: "t", defaultValue: "30000", description: "Timeout" },
      ],
      handler: async (_ctx, args) => ({
        exitCode: 0,
        stdout: JSON.stringify({
          target: args.get("target"),
          format: args.option("format"),
          timeout: args.option("timeout"),
        }),
        stderr: "",
      }),
    });

    test("uses default value when option not provided", async () => {
      const result = await cmd(["run", "myTarget"], makeCtx());
      const data = JSON.parse(result.stdout);
      expect(data.format).toBe("json");
      expect(data.timeout).toBe("30000");
    });

    test("explicit value overrides default", async () => {
      const result = await cmd(["run", "--format", "yaml", "myTarget"], makeCtx());
      const data = JSON.parse(result.stdout);
      expect(data.format).toBe("yaml");
      expect(data.timeout).toBe("30000");
    });
  });

  describe("required options", () => {
    const cmd = buildTestCommand({
      name: "deploy",
      description: "Deploy something",
      args: [{ name: "target" }],
      options: [{ name: "env", short: "e", required: true, description: "Target environment" }],
      handler: async (_ctx, args) => ({
        exitCode: 0,
        stdout: args.option("env"),
        stderr: "",
      }),
    });

    test("errors when required option is missing", async () => {
      const result = await cmd(["deploy", "app"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Missing required option --env");
    });

    test("succeeds when required option is provided", async () => {
      const result = await cmd(["deploy", "--env", "production", "app"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("production");
    });
  });

  describe("-- separator", () => {
    const cmd = buildTestCommand({
      name: "exec",
      description: "Execute something",
      args: [{ name: "cmd" }, { name: "arg1", required: false }, { name: "arg2", required: false }],
      options: [{ name: "verbose", short: "v", boolean: true }],
      handler: async (_ctx, args) => ({
        exitCode: 0,
        stdout: JSON.stringify({
          cmd: args.get("cmd"),
          arg1: args.get("arg1"),
          arg2: args.get("arg2"),
          verbose: args.flag("verbose"),
        }),
        stderr: "",
      }),
    });

    test("-- stops option parsing", async () => {
      const result = await cmd(["exec", "-v", "--", "--not-an-option", "value"], makeCtx());
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.verbose).toBe(true);
      expect(data.cmd).toBe("--not-an-option");
      expect(data.arg1).toBe("value");
    });

    test("args after -- that look like flags are treated as positional", async () => {
      const result = await cmd(["exec", "--", "-v", "--verbose"], makeCtx());
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.verbose).toBe(false);
      expect(data.cmd).toBe("-v");
      expect(data.arg1).toBe("--verbose");
    });
  });

  describe("unknown options", () => {
    const cmd = buildTestCommand({
      name: "run",
      description: "Run something",
      args: [{ name: "target" }, { name: "extra", required: false }],
      options: [{ name: "known", boolean: true }],
      handler: async (_ctx, args) => ({
        exitCode: 0,
        stdout: JSON.stringify({
          target: args.get("target"),
          extra: args.get("extra"),
          known: args.flag("known"),
        }),
        stderr: "",
      }),
    });

    test("unknown --option is treated as positional arg", async () => {
      const result = await cmd(["run", "--unknown", "myTarget"], makeCtx());
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.target).toBe("--unknown");
      expect(data.extra).toBe("myTarget");
    });
  });

  describe("help text", () => {
    const cmd = buildTestCommand({
      name: "fetch",
      description: "Fetch a URL",
      args: [{ name: "url", description: "Target URL" }],
      options: [
        { name: "header", short: "H", multiple: true, description: "HTTP header to send" },
        { name: "timeout", short: "t", defaultValue: "15000", description: "Request timeout in ms" },
        { name: "verbose", short: "v", boolean: true, description: "Show verbose output" },
        { name: "token", required: true, description: "Auth token" },
      ],
      handler: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });

    test("subcommand help includes options section", async () => {
      const result = await cmd(["fetch", "--help"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Options:");
      expect(result.stdout).toContain("--header");
      expect(result.stdout).toContain("-H");
      expect(result.stdout).toContain("(repeatable)");
      expect(result.stdout).toContain("--timeout");
      expect(result.stdout).toContain("-t");
      expect(result.stdout).toContain("[default: 15000]");
      expect(result.stdout).toContain("--verbose");
      expect(result.stdout).toContain("-v");
      expect(result.stdout).toContain("--token");
      expect(result.stdout).toContain("(required)");
    });

    test("usage line includes option placeholders", async () => {
      const result = await cmd(["fetch", "--help"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("[-H|--header");
      expect(result.stdout).toContain("[-t|--timeout");
      expect(result.stdout).toContain("[-v|--verbose]");
      expect(result.stdout).toContain("--token");
    });
  });

  describe("options with schema-based args", () => {
    const cmd = buildTestCommand({
      name: "add",
      description: "Add an item",
      schema: Type.Object({
        name: Type.String({ description: "Item name" }),
        count: Type.Number({ minimum: 1, description: "How many" }),
      }),
      options: [
        { name: "dry-run", boolean: true, description: "Preview only" },
        { name: "tag", short: "t", multiple: true, description: "Tags" },
      ],
      handler: async (_ctx, args) => {
        const v = args.validated<{ name: string; count: number }>()!;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            name: v.name,
            count: v.count,
            dryRun: args.flag("dry-run"),
            tags: args.options("tag"),
          }),
          stderr: "",
        };
      },
    });

    test("options work alongside schema validation", async () => {
      const result = await cmd(["add", "--dry-run", "-t", "urgent", "-t", "backend", "widget", "3"], makeCtx());
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.name).toBe("widget");
      expect(data.count).toBe(3);
      expect(data.dryRun).toBe(true);
      expect(data.tags).toEqual(["urgent", "backend"]);
    });

    test("schema validation still works with options present", async () => {
      const result = await cmd(["add", "--dry-run", "widget", "0"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Validation error");
    });
  });
});
