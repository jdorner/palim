/**
 * Tests for the `web` skill script command.
 *
 * Uses a local HTTP server (Bun.serve) to mock target webpages.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CommandContext, ExecResult } from "just-bash";
import { EMPTY_BYTES, InMemoryFs } from "just-bash";
import { buildCurlCommand, buildWebCommand, parseHeader, parseHeaders } from "./web";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeCtx(): CommandContext {
  return { fs: new InMemoryFs(), cwd: "/home/user/work", env: new Map(), stdin: EMPTY_BYTES };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("web command", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  let command: (args: string[], ctx: CommandContext) => Promise<ExecResult>;

  beforeEach(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname;

        // HTML page
        if (path === "/page") {
          const html = `<!DOCTYPE html>
<html>
<head><title>Test Page</title><style>body { color: red; }</style></head>
<body>
<nav><a href="/">Home</a></nav>
<h1>Hello World</h1>
<p>This is a <strong>test</strong> paragraph.</p>
<script>console.log("hidden")</script>
</body>
</html>`;
          return new Response(html, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }

        // Plain text
        if (path === "/plain") {
          return new Response("Just plain text content.", {
            headers: { "Content-Type": "text/plain" },
          });
        }

        // JSON response
        if (path === "/json") {
          return Response.json({ message: "hello", count: 42 });
        }

        // Large page (for truncation testing)
        if (path === "/large") {
          const body = "A".repeat(20000);
          return new Response(body, {
            headers: { "Content-Type": "text/plain" },
          });
        }

        // HTML entities
        if (path === "/entities") {
          const html = "<p>&amp; &lt;tag&gt; &quot;quoted&quot; &#39;apos&#39; &nbsp;space</p>";
          return new Response(html, {
            headers: { "Content-Type": "text/html" },
          });
        }

        // 404 error
        if (path === "/not-found") {
          return new Response("Not Found", { status: 404, statusText: "Not Found" });
        }

        // 500 error
        if (path === "/error") {
          return new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" });
        }

        // Redirect
        if (path === "/redirect") {
          return Response.redirect(`http://localhost:${server.port}/page`, 302);
        }

        // Echo headers back as JSON (for header testing)
        if (path === "/echo-headers") {
          const headers: Record<string, string> = {};
          req.headers.forEach((value, key) => {
            headers[key] = value;
          });
          return Response.json(headers);
        }

        return new Response("Not Found", { status: 404 });
      },
    });

    baseUrl = `http://localhost:${server.port}`;
    command = buildWebCommand({ defaultMaxLength: 12000 });
  });

  afterEach(() => {
    server.stop();
  });

  // ---------------------------------------------------------------------------
  // Routing & help
  // ---------------------------------------------------------------------------

  describe("routing", () => {
    test("shows help when no subcommand given", async () => {
      const result = await command([], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Fetch and read webpages");
      expect(result.stdout).toContain("fetch");
    });

    test("shows help with --help flag", async () => {
      const result = await command(["--help"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("fetch");
    });

    test("shows fetch subcommand help", async () => {
      const result = await command(["fetch", "--help"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("url");
      expect(result.stdout).toContain("--max-length");
    });

    test("returns error for unknown subcommand", async () => {
      const result = await command(["unknown"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown command");
    });
  });

  // ---------------------------------------------------------------------------
  // URL validation
  // ---------------------------------------------------------------------------

  describe("URL validation", () => {
    test("rejects URL without http:// or https://", async () => {
      const result = await command(["fetch", "ftp://example.com"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("URL must start with http:// or https://");
    });

    test("rejects bare domain without protocol", async () => {
      const result = await command(["fetch", "example.com"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("URL must start with http:// or https://");
    });

    test("accepts http:// URL", async () => {
      const result = await command(["fetch", `${baseUrl}/plain`], makeCtx());
      expect(result.exitCode).toBe(0);
    });

    test("requires url argument", async () => {
      const result = await command(["fetch"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Missing required argument");
    });
  });

  // ---------------------------------------------------------------------------
  // HTML fetching and stripping
  // ---------------------------------------------------------------------------

  describe("HTML processing", () => {
    test("strips HTML tags and returns plain text", async () => {
      const result = await command(["fetch", `${baseUrl}/page`], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Hello World");
      expect(result.stdout).toContain("test");
      expect(result.stdout).toContain("paragraph");
      expect(result.stdout).not.toContain("<h1>");
      expect(result.stdout).not.toContain("<p>");
      expect(result.stdout).not.toContain("<strong>");
    });

    test("removes script blocks", async () => {
      const result = await command(["fetch", `${baseUrl}/page`], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("console.log");
      expect(result.stdout).not.toContain("hidden");
    });

    test("removes style blocks", async () => {
      const result = await command(["fetch", `${baseUrl}/page`], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("color: red");
    });

    test("preserves nav content as markdown", async () => {
      const result = await command(["fetch", `${baseUrl}/page`], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Home");
    });

    test("decodes HTML entities", async () => {
      const result = await command(["fetch", `${baseUrl}/entities`], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("& <tag>");
      expect(result.stdout).toContain('"quoted"');
      expect(result.stdout).toContain("'apos'");
    });
  });

  // ---------------------------------------------------------------------------
  // Plain text and JSON
  // ---------------------------------------------------------------------------

  describe("non-HTML content", () => {
    test("returns plain text as-is", async () => {
      const result = await command(["fetch", `${baseUrl}/plain`], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Just plain text content.");
    });

    test("returns JSON as-is", async () => {
      const result = await command(["fetch", `${baseUrl}/json`], makeCtx());
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.message).toBe("hello");
      expect(parsed.count).toBe(42);
    });
  });

  // ---------------------------------------------------------------------------
  // Truncation
  // ---------------------------------------------------------------------------

  describe("truncation", () => {
    test("truncates output exceeding default max length", async () => {
      const cmd = buildWebCommand({ defaultMaxLength: 100 });
      const result = await cmd(["fetch", `${baseUrl}/large`], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("[Truncated");
      expect(result.stdout).toContain("20000 total characters");
      expect(result.stdout).toContain("showing first 100");
    });

    test("respects custom --max-length option", async () => {
      const result = await command(["fetch", "--max-length", "50", `${baseUrl}/large`], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("[Truncated");
      expect(result.stdout).toContain("showing first 50");
    });

    test("respects -m short option", async () => {
      const result = await command(["fetch", "-m", "75", `${baseUrl}/large`], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("[Truncated");
      expect(result.stdout).toContain("showing first 75");
    });

    test("does not truncate when content is within limit", async () => {
      const result = await command(["fetch", `${baseUrl}/plain`], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("[Truncated");
    });

    test("rejects invalid --max-length", async () => {
      const result = await command(["fetch", "--max-length", "abc", `${baseUrl}/plain`], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--max-length must be a positive integer");
    });

    test("rejects zero --max-length", async () => {
      const result = await command(["fetch", "--max-length", "0", `${baseUrl}/plain`], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--max-length must be a positive integer");
    });

    test("rejects negative --max-length", async () => {
      const result = await command(["fetch", "--max-length", "-5", `${baseUrl}/plain`], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--max-length must be a positive integer");
    });
  });

  // ---------------------------------------------------------------------------
  // HTTP errors
  // ---------------------------------------------------------------------------

  describe("HTTP errors", () => {
    test("reports 404 errors", async () => {
      const result = await command(["fetch", `${baseUrl}/not-found`], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("404");
    });

    test("reports 500 errors", async () => {
      const result = await command(["fetch", `${baseUrl}/error`], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("500");
    });
  });

  // ---------------------------------------------------------------------------
  // Redirects
  // ---------------------------------------------------------------------------

  describe("redirects", () => {
    test("follows redirects and returns final content", async () => {
      const result = await command(["fetch", `${baseUrl}/redirect`], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Hello World");
    });
  });

  // ---------------------------------------------------------------------------
  // Network errors
  // ---------------------------------------------------------------------------

  describe("network errors", () => {
    test("handles connection refused", async () => {
      const result = await command(["fetch", "http://localhost:1"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Error:");
    });
  });

  // ---------------------------------------------------------------------------
  // Custom headers
  // ---------------------------------------------------------------------------

  describe("custom headers", () => {
    test("sends a single custom header", async () => {
      const result = await command(
        ["fetch", "-H", "Authorization: Bearer token123", `${baseUrl}/echo-headers`],
        makeCtx(),
      );
      expect(result.exitCode).toBe(0);
      const headers = JSON.parse(result.stdout);
      expect(headers.authorization).toBe("Bearer token123");
    });

    test("sends multiple headers via repeated -H", async () => {
      const result = await command(
        ["fetch", "-H", "X-Api-Key: abc123", "-H", "X-Custom: hello", `${baseUrl}/echo-headers`],
        makeCtx(),
      );
      expect(result.exitCode).toBe(0);
      const headers = JSON.parse(result.stdout);
      expect(headers["x-api-key"]).toBe("abc123");
      expect(headers["x-custom"]).toBe("hello");
    });

    test("custom User-Agent header is ignored (stealth UA always used)", async () => {
      const result = await command(
        ["fetch", "--header", "User-Agent: CustomBot/1.0", `${baseUrl}/echo-headers`],
        makeCtx(),
      );
      expect(result.exitCode).toBe(0);
      const headers = JSON.parse(result.stdout);
      expect(headers["user-agent"]).not.toBe("CustomBot/1.0");
    });

    test("rejects malformed header (no colon)", async () => {
      const result = await command(["fetch", "-H", "InvalidHeader", `${baseUrl}/echo-headers`], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid header format");
      expect(result.stderr).toContain("InvalidHeader");
    });

    test("works with --max-length and headers together", async () => {
      const result = await command(
        ["fetch", "-H", "Authorization: Bearer xyz", "--max-length", "5000", `${baseUrl}/echo-headers`],
        makeCtx(),
      );
      expect(result.exitCode).toBe(0);
      const headers = JSON.parse(result.stdout);
      expect(headers.authorization).toBe("Bearer xyz");
    });

    test("handles header value with colons (e.g. URLs)", async () => {
      const result = await command(
        ["fetch", "-H", "X-Callback: https://example.com:8080/path", `${baseUrl}/echo-headers`],
        makeCtx(),
      );
      expect(result.exitCode).toBe(0);
      const headers = JSON.parse(result.stdout);
      expect(headers["x-callback"]).toBe("https://example.com:8080/path");
    });

    test("shows header option in subcommand help", async () => {
      const result = await command(["fetch", "--help"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("--header");
      expect(result.stdout).toContain("-H");
    });
  });
});

// ---------------------------------------------------------------------------
// Unit tests for header parsing helpers
// ---------------------------------------------------------------------------

describe("parseHeader", () => {
  test("parses valid header", () => {
    expect(parseHeader("Authorization: Bearer abc")).toEqual(["Authorization", "Bearer abc"]);
  });

  test("trims whitespace around name and value", () => {
    expect(parseHeader("  X-Key  :  some value  ")).toEqual(["X-Key", "some value"]);
  });

  test("handles value with colons", () => {
    expect(parseHeader("X-Url: https://example.com:443/path")).toEqual(["X-Url", "https://example.com:443/path"]);
  });

  test("returns null for missing colon", () => {
    expect(parseHeader("NoColonHere")).toBeNull();
  });

  test("returns null for colon at start (empty name)", () => {
    expect(parseHeader(": value")).toBeNull();
  });

  test("allows empty value", () => {
    expect(parseHeader("X-Empty:")).toEqual(["X-Empty", ""]);
  });
});

describe("parseHeaders", () => {
  test("parses multiple semicolon-separated headers", () => {
    const { headers, errors } = parseHeaders("A: 1;B: 2;C: 3");
    expect(headers).toEqual({ A: "1", B: "2", C: "3" });
    expect(errors).toEqual([]);
  });

  test("trims whitespace around semicolons", () => {
    const { headers, errors } = parseHeaders("  A: 1 ; B: 2 ");
    expect(headers).toEqual({ A: "1", B: "2" });
    expect(errors).toEqual([]);
  });

  test("reports malformed entries as errors", () => {
    const { headers, errors } = parseHeaders("A: 1;bad;B: 2");
    expect(headers).toEqual({ A: "1", B: "2" });
    expect(errors).toEqual(["bad"]);
  });

  test("handles empty input", () => {
    const { headers, errors } = parseHeaders("");
    expect(headers).toEqual({});
    expect(errors).toEqual([]);
  });

  test("handles single header without semicolons", () => {
    const { headers, errors } = parseHeaders("Authorization: Bearer token");
    expect(headers).toEqual({ Authorization: "Bearer token" });
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// curl command tests
// ---------------------------------------------------------------------------

describe("curl command", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  let curl: (args: string[], ctx: CommandContext) => Promise<ExecResult>;

  beforeEach(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname;

        if (path === "/page") {
          const html = `<!DOCTYPE html>
<html>
<head><title>Test</title><style>body{}</style></head>
<body><h1>Hello Curl</h1><p>Works great.</p><script>x()</script></body>
</html>`;
          return new Response(html, { headers: { "Content-Type": "text/html" } });
        }

        if (path === "/plain") {
          return new Response("plain text response", { headers: { "Content-Type": "text/plain" } });
        }

        if (path === "/json") {
          return Response.json({ ok: true });
        }

        if (path === "/large") {
          return new Response("X".repeat(20000), { headers: { "Content-Type": "text/plain" } });
        }

        if (path === "/echo-headers") {
          const headers: Record<string, string> = {};
          req.headers.forEach((value, key) => {
            headers[key] = value;
          });
          return Response.json(headers);
        }

        if (path === "/redirect") {
          return Response.redirect(`http://localhost:${server.port}/plain`, 302);
        }

        if (path === "/not-found") {
          return new Response("Not Found", { status: 404 });
        }

        return new Response("Not Found", { status: 404 });
      },
    });

    baseUrl = `http://localhost:${server.port}`;
    curl = buildCurlCommand({ defaultMaxLength: 12000 });
  });

  afterEach(() => {
    server.stop();
  });

  describe("basic fetching", () => {
    test("fetches plain text", async () => {
      const result = await curl([`${baseUrl}/plain`], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("plain text response");
    });

    test("fetches HTML and converts to markdown", async () => {
      const result = await curl([`${baseUrl}/page`], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Hello Curl");
      expect(result.stdout).toContain("Works great.");
      expect(result.stdout).not.toContain("<h1>");
      expect(result.stdout).not.toContain("<script>");
    });

    test("fetches JSON as-is", async () => {
      const result = await curl([`${baseUrl}/json`], makeCtx());
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
    });

    test("follows redirects by default", async () => {
      const result = await curl([`${baseUrl}/redirect`], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("plain text response");
    });
  });

  describe("URL validation", () => {
    test("errors when no URL is given", async () => {
      const result = await curl([], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("no URL specified");
    });

    test("rejects URL without protocol", async () => {
      const result = await curl(["example.com"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("URL must start with http:// or https://");
    });

    test("rejects ftp:// protocol", async () => {
      const result = await curl(["ftp://example.com"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("URL must start with http:// or https://");
    });
  });

  describe("headers (-H)", () => {
    test("sends a custom header", async () => {
      const result = await curl(["-H", "Authorization: Bearer secret", `${baseUrl}/echo-headers`], makeCtx());
      expect(result.exitCode).toBe(0);
      const headers = JSON.parse(result.stdout);
      expect(headers.authorization).toBe("Bearer secret");
    });

    test("sends multiple headers", async () => {
      const result = await curl(["-H", "X-One: 1", "-H", "X-Two: 2", `${baseUrl}/echo-headers`], makeCtx());
      expect(result.exitCode).toBe(0);
      const headers = JSON.parse(result.stdout);
      expect(headers["x-one"]).toBe("1");
      expect(headers["x-two"]).toBe("2");
    });

    test("errors on -H without value", async () => {
      const result = await curl(["-H"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("option -H requires a value");
    });

    test("errors on malformed header", async () => {
      const result = await curl(["-H", "NoColon", `${baseUrl}/echo-headers`], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("bad header format");
    });

    test("ignores custom User-Agent (stealth UA always used)", async () => {
      const result = await curl(["-H", "User-Agent: MyBot/1.0", `${baseUrl}/echo-headers`], makeCtx());
      expect(result.exitCode).toBe(0);
      const headers = JSON.parse(result.stdout);
      expect(headers["user-agent"]).not.toBe("MyBot/1.0");
    });
  });

  describe("truncation (--max-length)", () => {
    test("truncates output exceeding default max length", async () => {
      const shortCurl = buildCurlCommand({ defaultMaxLength: 100 });
      const result = await shortCurl([`${baseUrl}/large`], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("[Truncated");
      expect(result.stdout).toContain("showing first 100");
    });

    test("respects --max-length flag", async () => {
      const result = await curl(["--max-length", "50", `${baseUrl}/large`], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("[Truncated");
      expect(result.stdout).toContain("showing first 50");
    });

    test("errors on invalid --max-length", async () => {
      const result = await curl(["--max-length", "abc", `${baseUrl}/plain`], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--max-length must be a positive integer");
    });

    test("errors on --max-length without value", async () => {
      const result = await curl(["--max-length"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--max-length requires a value");
    });
  });

  describe("flags", () => {
    test("-s (silent) suppresses output file message", async () => {
      // silent flag alone doesn't change stdout for normal fetches
      const result = await curl(["-s", `${baseUrl}/plain`], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("plain text response");
    });

    test("-L (location) is accepted without error", async () => {
      const result = await curl(["-L", `${baseUrl}/redirect`], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("plain text response");
    });

    test("-o without value errors", async () => {
      const result = await curl(["-o"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("option -o requires a filename");
    });
  });

  describe("help", () => {
    test("shows help with --help", async () => {
      const result = await curl(["--help"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: curl");
      expect(result.stdout).toContain("--header");
      expect(result.stdout).toContain("--max-length");
      expect(result.stdout).toContain("--output");
    });

    test("shows help with -h", async () => {
      const result = await curl(["-h"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: curl");
    });
  });

  describe("error handling", () => {
    test("reports HTTP errors", async () => {
      const result = await curl([`${baseUrl}/not-found`], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("404");
    });

    test("handles connection refused", async () => {
      const result = await curl(["http://localhost:1"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("curl:");
    });
  });

  describe("HTTP method (-X)", () => {
    let methodServer: ReturnType<typeof Bun.serve>;
    let methodBaseUrl: string;

    beforeEach(() => {
      methodServer = Bun.serve({
        port: 0,
        async fetch(req) {
          const url = new URL(req.url);
          const path = url.pathname;

          if (path === "/echo") {
            const body = req.body ? await req.text() : "";
            return Response.json({
              method: req.method,
              body,
              contentType: req.headers.get("content-type") ?? "",
            });
          }

          return new Response("Not Found", { status: 404 });
        },
      });
      methodBaseUrl = `http://localhost:${methodServer.port}`;
    });

    afterEach(() => {
      methodServer.stop();
    });

    test("defaults to GET without -X", async () => {
      const result = await curl([`${methodBaseUrl}/echo`], makeCtx());
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.method).toBe("GET");
    });

    test("sends POST request with -X POST", async () => {
      const result = await curl(["-X", "POST", `${methodBaseUrl}/echo`], makeCtx());
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.method).toBe("POST");
    });

    test("sends PUT request with -X PUT", async () => {
      const result = await curl(["-X", "PUT", `${methodBaseUrl}/echo`], makeCtx());
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.method).toBe("PUT");
    });

    test("sends PATCH request with -X PATCH", async () => {
      const result = await curl(["-X", "PATCH", `${methodBaseUrl}/echo`], makeCtx());
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.method).toBe("PATCH");
    });

    test("sends DELETE request with -X DELETE", async () => {
      const result = await curl(["-X", "DELETE", `${methodBaseUrl}/echo`], makeCtx());
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.method).toBe("DELETE");
    });

    test("method is case-insensitive", async () => {
      const result = await curl(["-X", "post", `${methodBaseUrl}/echo`], makeCtx());
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.method).toBe("POST");
    });

    test("accepts --request as long form", async () => {
      const result = await curl(["--request", "POST", `${methodBaseUrl}/echo`], makeCtx());
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.method).toBe("POST");
    });

    test("errors on -X without value", async () => {
      const result = await curl(["-X"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("option -X requires a value");
    });

    test("errors on unsupported method", async () => {
      const result = await curl(["-X", "INVALID", `${methodBaseUrl}/echo`], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("unsupported method");
    });
  });

  describe("request body (-d)", () => {
    let methodServer: ReturnType<typeof Bun.serve>;
    let methodBaseUrl: string;

    beforeEach(() => {
      methodServer = Bun.serve({
        port: 0,
        async fetch(req) {
          const url = new URL(req.url);
          const path = url.pathname;

          if (path === "/echo") {
            const body = req.body ? await req.text() : "";
            return Response.json({
              method: req.method,
              body,
              contentType: req.headers.get("content-type") ?? "",
            });
          }

          return new Response("Not Found", { status: 404 });
        },
      });
      methodBaseUrl = `http://localhost:${methodServer.port}`;
    });

    afterEach(() => {
      methodServer.stop();
    });

    test("sends request body with -d", async () => {
      const result = await curl(["-X", "POST", "-d", '{"key":"value"}', `${methodBaseUrl}/echo`], makeCtx());
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.method).toBe("POST");
      expect(data.body).toBe('{"key":"value"}');
    });

    test("-d implies POST if -X not set", async () => {
      const result = await curl(["-d", "name=test", `${methodBaseUrl}/echo`], makeCtx());
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.method).toBe("POST");
      expect(data.body).toBe("name=test");
    });

    test("-d with explicit -X PUT sends PUT", async () => {
      const result = await curl(["-X", "PUT", "-d", "data=hello", `${methodBaseUrl}/echo`], makeCtx());
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.method).toBe("PUT");
      expect(data.body).toBe("data=hello");
    });

    test("multiple -d values are concatenated with &", async () => {
      const result = await curl(["-X", "POST", "-d", "a=1", "-d", "b=2", `${methodBaseUrl}/echo`], makeCtx());
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.body).toBe("a=1&b=2");
    });

    test("--data-raw works same as -d", async () => {
      const result = await curl(["--data-raw", '{"json":true}', `${methodBaseUrl}/echo`], makeCtx());
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.method).toBe("POST");
      expect(data.body).toBe('{"json":true}');
    });

    test("errors on -d without value", async () => {
      const result = await curl(["-d"], makeCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("option -d requires a value");
    });

    test("-d with custom Content-Type header", async () => {
      const result = await curl(
        ["-X", "POST", "-H", "Content-Type: application/json", "-d", '{"x":1}', `${methodBaseUrl}/echo`],
        makeCtx(),
      );
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.method).toBe("POST");
      expect(data.body).toBe('{"x":1}');
      expect(data.contentType).toBe("application/json");
    });
  });

  describe("help includes method and data options", () => {
    test("help mentions -X", async () => {
      const result = await curl(["--help"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("-X");
      expect(result.stdout).toContain("--request");
    });

    test("help mentions -d", async () => {
      const result = await curl(["--help"], makeCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("-d");
      expect(result.stdout).toContain("--data");
    });
  });
});
