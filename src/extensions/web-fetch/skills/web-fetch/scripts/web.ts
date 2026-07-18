/**
 * Registers the `web` shell command for fetching and reading webpages
 * from the agent sandbox.
 *
 * Subcommands: fetch
 */

import { createCommand, registerProgram, type SkillScriptContext } from "@ext/sdk";
import type { CommandContext, ExecResult } from "just-bash";
import rezo, { isRezoError, RezoStealth } from "rezo";
import TurndownService from "turndown";

/** Default maximum characters to return from a fetched page. */
const DEFAULT_MAX_LENGTH = 12_000;

/** Maximum redirects to follow. */
const MAX_REDIRECTS = 10;

/** Request timeout in milliseconds. */
const TIMEOUT_MS = 15_000;

/** User-Agent header to reduce bot-blocking. */
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

/**
 * Parses a header string in "Key: Value" format.
 *
 * @param raw - Raw header string (e.g. "Authorization: Bearer abc123")
 * @returns Tuple of [name, value] or null if the format is invalid
 */
export function parseHeader(raw: string): [string, string] | null {
  const colonIdx = raw.indexOf(":");
  if (colonIdx < 1) return null;
  const name = raw.slice(0, colonIdx).trim();
  const value = raw.slice(colonIdx + 1).trim();
  if (!name) return null;
  return [name, value];
}

/**
 * Parses a semicolon-separated header string into a record of header entries.
 * Each header must be in "Key: Value" format. Entries with invalid format are
 * skipped and reported as errors.
 *
 * @param input - Semicolon-separated headers (e.g. "Authorization: Bearer x;X-Custom: val")
 * @returns Object with parsed `headers` record and any `errors` for malformed entries
 */
export function parseHeaders(input: string): { headers: Record<string, string>; errors: string[] } {
  const headers: Record<string, string> = {};
  const errors: string[] = [];

  const parts = input
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const part of parts) {
    const parsed = parseHeader(part);
    if (parsed) {
      headers[parsed[0]] = parsed[1];
    } else {
      errors.push(part);
    }
  }

  return { headers, errors };
}

/** Options for building the web command handler. */
export interface WebCommandOptions {
  /** Maximum characters to return (overrides default). */
  defaultMaxLength?: number;
}

/**
 * Builds the `web` command handler function.
 *
 * Exported for unit testing - allows injecting options without
 * booting the full extension system.
 *
 * @param options - Command configuration
 * @returns A command handler suitable for `registerProgram()`
 */
export function buildWebCommand(options: WebCommandOptions = {}) {
  const maxLen = options.defaultMaxLength ?? DEFAULT_MAX_LENGTH;

  return createCommand({
    name: "web",
    description: "Fetch and read webpages from the internet.",
    subcommands: [
      {
        name: "fetch",
        description: "Fetch a webpage and return its text content",
        args: [{ name: "url", description: "URL to fetch (http:// or https://)" }],
        options: [
          {
            name: "max-length",
            short: "m",
            defaultValue: String(maxLen),
            description: "Max characters to return",
          },
          {
            name: "header",
            short: "H",
            multiple: true,
            description: 'HTTP header in "Name: Value" format',
          },
        ],
        handler: buildFetchHandler(maxLen),
      },
    ],
  });
}

/**
 * Builds a `curl`-like command handler that uses the same fetch infrastructure
 * as `web fetch`. Supports common curl flags: `-H` (headers), `-s` (silent),
 * `-L` (follow redirects, on by default), `-o` (output file), and
 * `--max-length` to control truncation.
 *
 * @param options - Command configuration
 * @returns A handler function suitable for `registerProgram()`
 */
export function buildCurlCommand(options: WebCommandOptions = {}) {
  const maxLen = options.defaultMaxLength ?? DEFAULT_MAX_LENGTH;
  const turndownService = new TurndownService();

  return async (args: string[], ctx: CommandContext): Promise<ExecResult> => {
    // Manual arg parsing to match curl's flag style
    const headerArgs: string[] = [];
    let silent = false;
    let outputFile = "";
    let maxLength = maxLen;
    let url = "";

    let i = 0;
    while (i < args.length) {
      const token = args[i]!;

      if (token === "-H" || token === "--header") {
        const val = args[i + 1];
        if (!val) {
          return { exitCode: 1, stdout: "", stderr: "curl: option -H requires a value" };
        }
        headerArgs.push(val);
        i += 2;
        continue;
      }

      if (token === "-s" || token === "--silent") {
        silent = true;
        i++;
        continue;
      }

      if (token === "-L" || token === "--location") {
        // Follow redirects - already default behavior, accept silently
        i++;
        continue;
      }

      if (token === "-o" || token === "--output") {
        const val = args[i + 1];
        if (!val) {
          return { exitCode: 1, stdout: "", stderr: "curl: option -o requires a filename" };
        }
        outputFile = val;
        i += 2;
        continue;
      }

      if (token === "--max-length") {
        const val = args[i + 1];
        if (!val) {
          return { exitCode: 1, stdout: "", stderr: "curl: option --max-length requires a value" };
        }
        const parsed = Number.parseInt(val, 10);
        if (Number.isNaN(parsed) || parsed < 1) {
          return { exitCode: 1, stdout: "", stderr: "curl: --max-length must be a positive integer" };
        }
        maxLength = parsed;
        i += 2;
        continue;
      }

      if (token === "--help" || token === "-h") {
        return { exitCode: 0, stdout: CURL_HELP, stderr: "" };
      }

      // Skip unsupported flags that take no value
      if (token.startsWith("-") && token.length === 2 && !url) {
        // Unknown single-char flag without value - skip
        i++;
        continue;
      }

      // Skip unsupported long flags
      if (token.startsWith("--") && !url) {
        // Check if next arg looks like a value for this flag
        const next = args[i + 1];
        if (next && !next.startsWith("-")) {
          i += 2;
        } else {
          i++;
        }
        continue;
      }

      // Positional arg = URL
      if (!url) {
        url = token;
      }
      i++;
    }

    if (!url) {
      return { exitCode: 1, stdout: "", stderr: "curl: no URL specified\n\nUsage: curl [options] <url>" };
    }

    // Validate URL
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return { exitCode: 1, stdout: "", stderr: "curl: URL must start with http:// or https://" };
    }

    // Parse custom headers
    const customHeaders: Record<string, string> = {};
    for (const raw of headerArgs) {
      const parsed = parseHeader(raw);
      if (!parsed) {
        return { exitCode: 1, stdout: "", stderr: `curl: bad header format (expected "Name: Value"): ${raw}` };
      }
      customHeaders[parsed[0]] = parsed[1];
    }

    try {
      // Remove any User-Agent header the user may have set
      if (customHeaders["User-Agent"]) {
        delete customHeaders["User-Agent"];
      }

      const stealth = new RezoStealth({
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
          "Accept-Encoding": "gzip, deflate, zstd",
          ...customHeaders,
        },
      });

      const client = rezo.create({
        stealth,
        timeout: TIMEOUT_MS,
        retry: 0,
        followRedirects: true,
        maxRedirects: MAX_REDIRECTS,
      });

      const resp = await client.get(url, { responseType: "text" });

      const contentType = resp.headers.get("content-type") ?? "";
      const body = resp.data;
      if (typeof body !== "string") {
        return { exitCode: 1, stdout: "", stderr: "curl: unexpected response data format" };
      }

      // Convert HTML to markdown, pass through everything else
      let text: string;
      if (contentType.includes("html") || body.trimStart().startsWith("<!") || body.trimStart().startsWith("<html")) {
        text = turndownService.remove(["head", "script", "style"]).turndown(body);
      } else {
        text = body;
      }

      // Truncate if needed
      if (text.length > maxLength) {
        text = `${text.slice(0, maxLength)}\n\n[Truncated - ${text.length} total characters, showing first ${maxLength}]`;
      }

      // Output to file if -o was specified
      if (outputFile) {
        try {
          const resolvedPath = ctx.fs.resolvePath(ctx.cwd, outputFile);
          await ctx.fs.writeFile(resolvedPath, text);
          if (!silent) {
            return { exitCode: 0, stdout: `Saved to ${outputFile} (${text.length} characters)`, stderr: "" };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { exitCode: 1, stdout: "", stderr: `curl: failed to write to ${outputFile}: ${msg}` };
        }
      }

      return { exitCode: 0, stdout: text, stderr: "" };
    } catch (error) {
      if (isRezoError(error)) {
        return { exitCode: 1, stdout: "", stderr: `curl: ${error.toString()}` };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { exitCode: 1, stdout: "", stderr: `curl: ${message}` };
    }
  };
}

/** Help text for the curl command. */
const CURL_HELP = `Usage: curl [options] <url>

Fetch a webpage and return its text content (HTML is converted to markdown).

Options:
  -H, --header <"Name: Value">  Add a custom HTTP header (repeatable)
  -s, --silent                   Suppress progress/info messages
  -L, --location                 Follow redirects (default: on)
  -o, --output <file>            Write output to file instead of stdout
      --max-length <n>           Max characters to return (default: ${DEFAULT_MAX_LENGTH})
  -h, --help                     Show this help text

Examples:
  curl https://example.com
  curl -H "Authorization: Bearer token" https://api.example.com/data
  curl -o page.md https://example.com
  curl --max-length 5000 https://example.com`;

/**
 * Registers the `web` shell command with the sandbox.
 *
 * @param skillName - The skill name this program belongs to
 * @param ctx - Pre-built URLs provided by the extension registry
 */
export async function registerSkill(skillName: string, _ctx: SkillScriptContext) {
  const useAlternativeMessage = {
    exitCode: 1,
    stdout: "Use `web fetch` or `curl` instead!",
    stderr: "Use `web fetch` or `curl` instead!",
  };
  const command = buildWebCommand();
  const curlCommand = buildCurlCommand();

  registerProgram("web", command, skillName);
  registerProgram("curl", curlCommand, skillName);
  registerProgram("wget", async () => useAlternativeMessage, skillName);
}

// ---------------------------------------------------------------------------
// Handler factories
// ---------------------------------------------------------------------------

/**
 * Builds the fetch subcommand handler.
 *
 * @param defaultMaxLength - Default max characters for output
 * @returns Handler function for the fetch subcommand
 */
function buildFetchHandler(defaultMaxLength: number) {
  const turndownService = new TurndownService();

  return async (
    _ctx: CommandContext,
    args: { get(name: string): string; option(name: string): string; options(name: string): string[] },
  ): Promise<ExecResult> => {
    const url = args.get("url");
    const maxLengthStr = args.option("max-length");
    const headerArgs = args.options("header");

    // Validate URL
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Error: URL must start with http:// or https://",
      };
    }

    // Parse max length from option (always present due to defaultValue)
    let maxLength = defaultMaxLength;
    if (maxLengthStr) {
      const parsed = Number.parseInt(maxLengthStr, 10);
      if (Number.isNaN(parsed) || parsed < 1) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "Error: --max-length must be a positive integer",
        };
      }
      maxLength = parsed;
    }

    // Parse custom headers from --header / -H options
    const customHeaders: Record<string, string> = {};
    for (const raw of headerArgs) {
      const parsed = parseHeader(raw);
      if (!parsed) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `Error: Invalid header format (expected "Name: Value"): ${raw}`,
        };
      }
      customHeaders[parsed[0]] = parsed[1];
    }

    try {
      // Remove any User-Agent header the user may have set, since we always want to override it
      if (customHeaders?.["User-Agent"]) {
        delete customHeaders?.["User-Agent"];
      }

      const stealth = new RezoStealth({
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
          "Accept-Encoding": "gzip, deflate, zstd",
          ...customHeaders,
        },
      });

      const client = rezo.create({
        stealth,
        timeout: TIMEOUT_MS,
        retry: 0,
        followRedirects: true,
        maxRedirects: MAX_REDIRECTS,
      });

      const resp = await client.get(url, { responseType: "text" });

      const contentType = resp.headers.get("content-type") ?? "";
      const body = resp.data;
      if (typeof body !== "string") {
        return { exitCode: 1, stdout: "", stderr: "Error: Unexpected response data format" };
      }

      // If it looks like HTML, strip tags
      let text: string = "";
      if (contentType.includes("html") || body.trimStart().startsWith("<!") || body.trimStart().startsWith("<html")) {
        text = turndownService.remove(["head", "script", "style"]).turndown(body);
      } else {
        // Plain text, JSON, etc. - return as-is
        text = body;
      }

      // Truncate if needed
      if (text.length > maxLength) {
        text = `${text.slice(0, maxLength)}\n\n[Truncated - ${text.length} total characters, showing first ${maxLength}]`;
      }

      return { exitCode: 0, stdout: text, stderr: "" };
    } catch (error) {
      if (isRezoError(error)) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: error.toString(),
        };
      }

      const message = error instanceof Error ? error.message : String(error);
      return { exitCode: 1, stdout: "", stderr: `Error: ${message}` };
    }
  };
}
