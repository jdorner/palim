/**
 * Registers the `convert` shell command for converting files to markdown
 * via the converter extension's HTTP endpoint.
 *
 * Supports two input modes:
 * - `--file <path>` - convert a file from the virtual filesystem
 * - stdin (pipe/redirect) - convert piped binary data directly
 *
 * Options:
 * - `--file` / `-f` - Path to the file to convert
 * - `--output` / `-o` - Write result to this path instead of stdout
 * - `--prompt` / `-p` - Custom system prompt overriding the default OCR instructions
 */

import { formatFetchError, formatHttpError, registerProgram, type SkillScriptContext } from "@ext/sdk";
import { type CommandContext, EMPTY_BYTES, type ExecResult, latin1FromBytes } from "just-bash";

/**
 * Builds the `convert` command handler function.
 *
 * Exported for unit testing - allows injecting a base URL without
 * booting the full extension system.
 *
 * @param scriptCtx - Skill script context providing the extension base URL and authenticated fetch
 * @returns A command handler suitable for `registerProgram()`
 */
export function buildConvertCommand(scriptCtx: SkillScriptContext) {
  return async (args: string[], ctx: CommandContext): Promise<ExecResult> => {
    const parsed = parseArgs(args);

    if (parsed.help) {
      return { exitCode: 0, stdout: HELP_TEXT, stderr: "" };
    }

    if (parsed.error) {
      return { exitCode: 1, stdout: "", stderr: `Error: ${parsed.error}\n\n${HELP_TEXT}` };
    }

    const { filePath, outputPath, prompt } = parsed;

    // Determine input mode: --file takes priority, otherwise read stdin
    const hasStdin = ctx.stdin !== EMPTY_BYTES && ctx.stdin !== ("" as unknown);
    if (!filePath && !hasStdin) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Error: No input provided. Use --file <path> or pipe data via stdin.\n\n${HELP_TEXT}`,
      };
    }

    try {
      // Build request payload
      const payload: { path?: string; data?: string; prompt?: string } = {};

      if (filePath) {
        payload.path = filePath;
      } else {
        // Read stdin as raw bytes and base64-encode for transport
        const raw = latin1FromBytes(ctx.stdin);
        const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
        payload.data = Buffer.from(bytes).toString("base64");
      }

      if (prompt) {
        payload.prompt = prompt;
      }

      const resp = await scriptCtx.fetch(`${scriptCtx.baseUrl}/convert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        return formatHttpError(resp);
      }

      const result = (await resp.json()) as { markdown: string };
      const markdown = result.markdown;

      if (outputPath) {
        try {
          await ctx.fs.writeFile(ctx.fs.resolvePath(ctx.cwd, outputPath), markdown);
          return { exitCode: 0, stdout: `Markdown written to ${outputPath}`, stderr: "" };
        } catch (err) {
          return {
            exitCode: 1,
            stdout: markdown,
            stderr: `Warning: could not write to ${outputPath}: ${err}. Markdown printed to stdout instead.`,
          };
        }
      }

      return { exitCode: 0, stdout: markdown, stderr: "" };
    } catch (error) {
      return { exitCode: 1, stdout: "", stderr: formatFetchError(error as Error) };
    }
  };
}

/**
 * Registers the `convert` shell command with the sandbox.
 *
 * @param skillName - The skill name this program belongs to
 * @param ctx - Context from the extension registry
 */
export async function registerSkill(skillName: string, ctx: SkillScriptContext) {
  const command = buildConvertCommand(ctx);
  registerProgram("convert", command, skillName);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/** Parsed arguments from the convert command invocation. */
interface ConvertArgs {
  filePath: string;
  outputPath: string;
  prompt: string;
  help: boolean;
  error: string;
}

const HELP_TEXT = `Convert files (PDFs, images) to markdown text.

Usage: convert [--file <path>] [--output <path>] [--prompt <text>]

When --file is omitted, input is read from stdin (pipe or redirect).

Options:
  -f, --file     Path to the file to convert
  -o, --output   Write markdown to this path instead of stdout
  -p, --prompt   Custom system prompt overriding the default OCR instructions

Examples:
  convert --file data/raw/document.pdf
  convert -f data/raw/photo.png -o data/wiki/pages/photo.md
  convert --file image.png --prompt "Is there a blue ball in this image?"
  cat data/raw/image.png | convert
  cat data/raw/invoice.pdf | convert --prompt "Extract the total amount"`;

/**
 * Parses raw CLI args into structured options.
 *
 * @param args - Raw argument tokens (command name already stripped by just-bash)
 * @returns Parsed arguments object
 */
function parseArgs(args: string[]): ConvertArgs {
  const result: ConvertArgs = { filePath: "", outputPath: "", prompt: "", help: false, error: "" };

  let i = 0;
  while (i < args.length) {
    const token = args[i]!;

    if (token === "--help" || token === "-h") {
      result.help = true;
      return result;
    }

    if (token === "--file" || token === "-f") {
      const val = args[++i];
      if (!val) {
        result.error = "Missing value for --file";
        return result;
      }
      result.filePath = val;
    } else if (token === "--output" || token === "-o") {
      const val = args[++i];
      if (!val) {
        result.error = "Missing value for --output";
        return result;
      }
      result.outputPath = val;
    } else if (token === "--prompt" || token === "-p") {
      const val = args[++i];
      if (!val) {
        result.error = "Missing value for --prompt";
        return result;
      }
      result.prompt = val;
    } else if (token === "--") {
      // Stop parsing options
      i++;
      break;
    } else if (token.startsWith("-")) {
      result.error = `Unknown option: ${token}`;
      return result;
    } else {
      // Treat as positional file path for backwards compat with `convert file <path>` style
      // (ignored - user should use --file)
      result.error = `Unexpected argument: ${token}. Use --file <path> to specify input.`;
      return result;
    }

    i++;
  }

  return result;
}
