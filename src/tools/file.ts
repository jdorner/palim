import assert from "node:assert";
import { default as path } from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { WORK_DIR } from "@src/config";
import { mainLogger as log, shellLogger as shellLog } from "@src/utils/logger";
import type { Bash } from "just-bash";

// ---------------------------------------------------------------------------
// Param schemas
// ---------------------------------------------------------------------------

const ReadFileParams = Type.Object(
  {
    path: Type.String({ description: "File path" }),
    startLine: Type.Optional(
      Type.Number({ description: "First line to read (1-based, inclusive). Omit to start from the beginning." }),
    ),
    endLine: Type.Optional(
      Type.Number({ description: "Last line to read (1-based, inclusive). Omit to read to the end." }),
    ),
  },
  { additionalProperties: false },
);

const WriteFileParams = Type.Object(
  {
    path: Type.String({ description: "File path" }),
    content: Type.String({ description: "Content to write" }),
  },
  { additionalProperties: false },
);

const ListFilesParams = Type.Object(
  {
    path: Type.String({ description: "Directory path" }),
  },
  { additionalProperties: false },
);

const CreateDirectoryParams = Type.Object(
  {
    path: Type.String({ description: "Directory path to create" }),
  },
  { additionalProperties: false },
);

const EditFileParams = Type.Object(
  {
    path: Type.String({ description: "Path to the file to edit" }),
    edits: Type.Array(
      Type.Object(
        {
          oldText: Type.String({
            description:
              "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
          }),
          newText: Type.String({ description: "Replacement text for this targeted edit." }),
        },
        {
          description:
            "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
          additionalProperties: false,
        },
      ),
    ),
  },
  { additionalProperties: false },
);

const ExecuteCommandParams = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
});

// ---------------------------------------------------------------------------
// Host path helper (used by OCR, not by sandbox file tools)
// ---------------------------------------------------------------------------

/**
 * Validate that an absolute path resolves within the work directory.
 * Used by non-sandbox code (e.g. OCR) that operates on host paths directly.
 *
 * @param absolutePath - Already-resolved absolute path
 * @returns The validated absolute path
 * @throws If the path escapes the work directory
 */
export function assertInsideWorkDir(absolutePath: string): string {
  assert(WORK_DIR && WORK_DIR.length > 0);

  const resolved = path.resolve(absolutePath);
  if (!resolved.startsWith(WORK_DIR)) {
    log.error(`Access denied: ${absolutePath}`);
    throw new Error(`Access denied: ${absolutePath}`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Tool names - exported so callers can filter / reference them by name
// ---------------------------------------------------------------------------

/** Names of all tools created by {@link createSandboxTools}. */
export const SANDBOX_TOOL_NAMES = new Set([
  "exec",
  "read_file",
  "write_file",
  "list_files",
  "edit",
  "create_directory",
]);

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates the full set of sandbox-bound agent tools from a {@link Bash}
 * instance: the `exec` shell tool plus all file-manipulation tools.
 *
 * File paths the agent supplies are resolved relative to the shell's
 * working directory inside the virtual filesystem. Path-escape protection
 * is handled by the underlying {@link ReadWriteFs} mount - no host-path
 * juggling required.
 *
 * @param shell - A configured Bash instance (typically from {@link createShell})
 * @returns An array of {@link AgentTool} instances
 */
export function createSandboxTools(shell: Bash): AgentTool[] {
  const fs = shell.fs;
  const cwd = shell.getCwd();

  /** Resolve a user-supplied path against the shell cwd. */
  const resolve = (p: string): string => fs.resolvePath(cwd, p);

  // -----------------------------------------------------------------------
  // exec (shell command execution)
  // -----------------------------------------------------------------------
  const execTool: AgentTool = {
    name: "exec",
    label: "Execute Command",
    description: "Execute a shell command and return its output as a string",
    parameters: ExecuteCommandParams,
    execute: async (
      _toolCallId: string,
      paramsRaw: unknown,
      _signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<any>,
    ): Promise<AgentToolResult<any>> => {
      const params = paramsRaw as Static<typeof ExecuteCommandParams>;

      onUpdate?.({
        content: [{ type: "text", text: `Executing: \`${params.command}\`` }],
        details: {},
      });

      try {
        const result = await shell.exec(params.command);

        const stdout = result.stdout ? result.stdout : "";
        const stderr = result.stderr ? result.stderr : "";
        const exitCode = result.exitCode;

        if (exitCode !== 0) {
          const output = [`Exit code: ${exitCode}`, stdout && `Output:\n${stdout}`, stderr && `Error:\n${stderr}`]
            .filter(Boolean)
            .join("\n\n");

          shellLog.warn(`Command exited with code ${exitCode}\n${params.command}\n${output}`);

          return {
            content: [{ type: "text", text: output }],
            details: { exitCode, stdout, stderr },
          };
        }

        shellLog.info(`Command completed successfully: ${params.command}`);

        return {
          content: [{ type: "text", text: stdout || "(no output)" }],
          details: { exitCode, stdout },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        shellLog.error(`Command execution error: ${errorMessage}`);

        return {
          content: [{ type: "text", text: `Error: ${errorMessage}` }],
          details: { error: errorMessage },
        };
      }
    },
  };

  // -----------------------------------------------------------------------
  // read_file
  // -----------------------------------------------------------------------
  const readFileTool: AgentTool = {
    name: "read_file",
    label: "Read File",
    description: "Read a file's contents. Optionally specify startLine and endLine to read only a portion of the file.",
    parameters: ReadFileParams,
    execute: async (_toolCallId, paramsRaw: unknown, _signal, onUpdate) => {
      const params = paramsRaw as Static<typeof ReadFileParams>;
      const filePath = resolve(params.path);

      const rangeLabel =
        params.startLine != null || params.endLine != null
          ? ` (lines ${params.startLine ?? 1} – ${params.endLine ?? "end"})`
          : "";

      onUpdate?.({ content: [{ type: "text", text: `Reading \`${params.path}\`${rangeLabel}...` }], details: {} });

      const raw = await fs.readFile(filePath);

      let output: string;
      let totalLines: number;

      if (params.startLine != null || params.endLine != null) {
        const lines = raw.split("\n");
        totalLines = lines.length;
        const start = Math.max(1, params.startLine ?? 1);
        const end = Math.min(totalLines, params.endLine ?? totalLines);

        if (end < start) {
          return {
            content: [{ type: "text", text: `Invalid range: endLine (${end}) is before startLine (${start}).` }],
            details: { path: params.path, totalLines },
          };
        }

        if (start > totalLines) {
          return {
            content: [{ type: "text", text: `File "${params.path}" has only ${totalLines} lines.` }],
            details: { path: params.path, totalLines },
          };
        }

        const selected = lines.slice(start - 1, end);
        // Prefix each line with its line number for easy reference
        const numbered = selected.map((line, i) => `${start + i}: ${line}`).join("\n");
        output = numbered;
      } else {
        totalLines = raw.split("\n").length;
        output = raw;
      }

      return {
        content: [{ type: "text", text: output }],
        details: { path: params.path, size: output.length, totalLines },
      };
    },
  };

  // -----------------------------------------------------------------------
  // write_file
  // -----------------------------------------------------------------------
  const writeFileTool: AgentTool = {
    name: "write_file",
    label: "Write File",
    description: "Write a file's contents. Creates the file if it does not exist.",
    parameters: WriteFileParams,
    execute: async (_toolCallId, paramsRaw: unknown, _signal, onUpdate) => {
      const params = paramsRaw as Static<typeof WriteFileParams>;
      const filePath = resolve(params.path);

      onUpdate?.({ content: [{ type: "text", text: `Writing \`${params.path}\`...` }], details: {} });

      await fs.writeFile(filePath, params.content);

      return {
        content: [{ type: "text", text: "File written" }],
        details: { path: params.path, size: params.content.length },
      };
    },
  };

  // -----------------------------------------------------------------------
  // list_files
  // -----------------------------------------------------------------------
  const listFilesTool: AgentTool = {
    name: "list_files",
    label: "List Files",
    description: "List the files inside a directory",
    parameters: ListFilesParams,
    execute: async (_toolCallId, paramsRaw: unknown, _signal, onUpdate) => {
      const params = paramsRaw as Static<typeof ListFilesParams>;
      const dirPath = resolve(params.path);

      onUpdate?.({ content: [{ type: "text", text: `Listing files in \`${params.path}\`...` }], details: {} });

      const entries = await fs.readdir(dirPath);

      // Enrich with trailing slash for directories
      const lines: string[] = [];
      for (const name of entries) {
        const entryPath = fs.resolvePath(dirPath, name);
        const stat = await fs.stat(entryPath);
        lines.push(stat.isDirectory ? `${name}/` : name);
      }

      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  };

  // -----------------------------------------------------------------------
  // create_directory
  // -----------------------------------------------------------------------
  const createDirectoryTool: AgentTool = {
    name: "create_directory",
    label: "Create Directory",
    description: "Create a new directory. Creates parent directories if they don't exist.",
    parameters: CreateDirectoryParams,
    execute: async (_toolCallId, paramsRaw: unknown, _signal, onUpdate) => {
      const params = paramsRaw as Static<typeof CreateDirectoryParams>;
      const dirPath = resolve(params.path);

      onUpdate?.({ content: [{ type: "text", text: `Creating directory \`${params.path}\`...` }], details: {} });

      await fs.mkdir(dirPath, { recursive: true });

      return {
        content: [{ type: "text", text: "Directory created" }],
        details: { path: params.path },
      };
    },
  };

  /**
   * Apply one or more targeted text replacements to a file.
   *
   * Each edit specifies an `oldText` that must appear exactly once in the
   * original file content, plus a `newText` to replace it with. All edits
   * are validated against the original content first (not incrementally),
   * then applied in order. If any `oldText` is not found or is ambiguous,
   * the entire operation fails and nothing is written.
   */
  const editFileTool: AgentTool = {
    name: "edit",
    label: "Edit File",
    description:
      "Apply targeted text replacements to a file. " +
      "Each edit's oldText must be unique in the file. " +
      "All edits are atomic - if any oldText is missing or ambiguous, nothing is written.",
    parameters: EditFileParams,
    execute: async (_toolCallId, paramsRaw: unknown, _signal, onUpdate) => {
      const params = paramsRaw as Static<typeof EditFileParams>;
      const filePath = resolve(params.path);

      onUpdate?.({
        content: [{ type: "text", text: `Editing \`${params.path}\` with ${params.edits.length} replacement(s)...` }],
        details: {},
      });

      const fileContent = await fs.readFile(filePath);

      // Validate all edits against the original content before applying any.
      for (let i = 0; i < params.edits.length; i++) {
        const edit = params.edits[i]!;
        const firstIdx = fileContent.indexOf(edit.oldText);

        if (firstIdx === -1) {
          const preview = edit.oldText.length > 120 ? `${edit.oldText.slice(0, 120)}...` : edit.oldText;
          throw new Error(
            `Edit ${i + 1} failed: oldText not found in \`${params.path}\`.\n\n` +
              `Could not find: ${JSON.stringify(preview)}`,
          );
        }

        // Ensure oldText is unique in the file.
        if (fileContent.indexOf(edit.oldText, firstIdx + 1) !== -1) {
          const preview = edit.oldText.length > 80 ? `${edit.oldText.slice(0, 80)}...` : edit.oldText;
          throw new Error(
            `Edit ${i + 1} failed: "${preview}" appears multiple times in \`${params.path}\`. ` +
              `Provide a more specific oldText that is unique in the file.`,
          );
        }
      }

      // Apply all edits sequentially against the evolving content.
      let result = fileContent;
      for (let i = 0; i < params.edits.length; i++) {
        const edit = params.edits[i]!;
        const idx = result.indexOf(edit.oldText);

        if (idx === -1) {
          // This can happen if a previous edit removed or altered overlapping text.
          const preview = edit.oldText.length > 120 ? `${edit.oldText.slice(0, 120)}...` : edit.oldText;
          throw new Error(
            `Edit ${i + 1} failed during apply: oldText no longer found after prior edits. ` +
              `Edits may be overlapping.\n\nCould not find: ${JSON.stringify(preview)}`,
          );
        }

        result = result.slice(0, idx) + edit.newText + result.slice(idx + edit.oldText.length);
      }

      await fs.writeFile(filePath, result);

      return {
        content: [
          {
            type: "text",
            text: `File \`${params.path}\` edited successfully with ${params.edits.length} replacement(s).`,
          },
        ],
        details: { path: params.path, editsApplied: params.edits.length },
      };
    },
  };

  return [execTool, readFileTool, writeFileTool, listFilesTool, createDirectoryTool, editFileTool];
}
