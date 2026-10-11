/**
 * `convert` workflow step: converts a file from the work directory (image or
 * PDF) to markdown with the vision LLM, without an agent step in between.
 *
 * The file is read through the step's work-dir-scoped filesystem, so paths
 * like `{{trigger.payload.file.path}}` or `inbox/scan.pdf` work and nothing
 * outside the work directory can be read.
 *
 * @module
 */

import { basename } from "node:path";
import { formatValidationErrors } from "@ext/sdk";
import type { StepExecutionContext, StepTypeHandler } from "@ext/types";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** Configuration schema of the `convert` step. */
export const ConvertStepConfigSchema = Type.Object({
  file: Type.String({
    title: "File",
    description: "Path of the image or PDF, relative to the work directory. Supports {{template}} expressions.",
    minLength: 1,
  }),
  prompt: Type.Optional(
    Type.String({
      title: "Prompt",
      description:
        "Instructions replacing the default OCR prompt (e.g. what to extract). Supports {{template}} expressions.",
      multiline: true,
    }),
  ),
  output: Type.Optional(
    Type.String({
      title: "Save as",
      description:
        "Optional path (relative to the work directory) to also write the markdown to. Supports {{template}} expressions.",
    }),
  ),
});

/** Result of the `convert` step. */
export interface ConvertStepResult {
  /** The converted markdown. */
  markdown: string;
  /** The converted file (work-dir path). */
  file: string;
  /** Where the markdown was saved, when `output` was set. */
  output: string | null;
}

/**
 * Converts file bytes to markdown.
 *
 * @param bytes - The file content
 * @param filename - Display name of the file (for logs and job labels)
 * @param prompt - Optional prompt replacing the default OCR instructions
 * @returns The markdown
 * @throws When the file type is unsupported or the conversion fails
 */
export type ConvertBytesFn = (bytes: Uint8Array, filename: string, prompt?: string) => Promise<string>;

/**
 * Resolves a template field and logs its warnings to the job.
 *
 * @param ctx - The step context
 * @param field - Field name (for the log)
 * @param value - The raw field value
 * @returns The resolved value, trimmed
 */
async function resolveField(ctx: StepExecutionContext, field: string, value: string): Promise<string> {
  const { resolved, warnings } = await ctx.resolveTemplate(value);
  for (const warning of warnings) await ctx.jobLog(`Warning (${field}): ${warning}`);
  return resolved.trim();
}

/**
 * Creates the `convert` step handler.
 *
 * @param convertBytes - Runs a conversion (the converter's queue)
 * @returns The step handler
 */
export function createConvertStepHandler(convertBytes: ConvertBytesFn): StepTypeHandler {
  return {
    schema: ConvertStepConfigSchema,
    label: "Convert to Markdown",
    icon: "FileTextIcon",
    outputSchema: Type.Object({
      markdown: Type.String({ description: "The converted markdown." }),
      file: Type.String({ description: "The converted file (work-dir path)." }),
      output: Type.Union([Type.String(), Type.Null()], { description: "Where the markdown was saved, if requested." }),
    }),

    async execute(stepDef, ctx): Promise<ConvertStepResult> {
      const { slug: _slug, type: _type, outputSchema: _os, ...config } = stepDef;
      if (!Value.Check(ConvertStepConfigSchema, config)) {
        throw new Error(
          `Invalid convert step configuration: ${formatValidationErrors(ConvertStepConfigSchema, config)}`,
        );
      }

      const file = await resolveField(ctx, "file", config.file);
      if (!file) throw new Error("The file path resolved to an empty value");
      const prompt = config.prompt ? await resolveField(ctx, "prompt", config.prompt) : "";

      const path = ctx.fs.resolvePath("/", file);
      let bytes: Uint8Array;
      try {
        bytes = await ctx.fs.readFileBuffer(path);
      } catch (err) {
        // Only a missing file is "not found"; anything else (too large, a
        // directory, outside the work dir) keeps the filesystem's reason.
        const message = err instanceof Error ? err.message : String(err);
        if ((err as { code?: string }).code === "ENOENT" || message.startsWith("ENOENT")) {
          throw new Error(`File not found in the work directory: ${file}`);
        }
        throw new Error(`Cannot read ${file}: ${message}`);
      }

      await ctx.jobLog(`Converting ${file} (${bytes.byteLength} bytes)`);
      const markdown = await convertBytes(bytes, basename(file), prompt || undefined);

      let output: string | null = null;
      if (config.output) {
        output = await resolveField(ctx, "output", config.output);
        if (output) {
          const target = ctx.fs.resolvePath("/", output);
          const dir = target.slice(0, target.lastIndexOf("/"));
          if (dir) await ctx.fs.mkdir(dir, { recursive: true });
          await ctx.fs.writeFile(target, markdown);
          await ctx.jobLog(`Saved markdown to ${output}`);
        }
      }

      return { markdown, file, output };
    },
  };
}
