/**
 * Converter extension - converts files (PDFs, images) to markdown text
 * using a vision LLM agent.
 *
 * Exposes a `POST /ext/converter/convert` endpoint that accepts:
 * - `data`: an array of base64-encoded file contents (required)
 * - `filenames`: optional display names aligned with `data`, used only for job labels/logs
 * Multiple inputs are merged into a single conversion (pages of one document).
 *
 * It also registers the `convert` workflow step, which converts a file from
 * the work directory (see `convertStep.ts`).
 *
 * Conversion jobs are processed on the `converter:jobs` queue, giving
 * visibility in the web UI.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatValidationErrors } from "@ext/sdk";
import type {
  AgentProcessorResult,
  Extension,
  ExtensionContext,
  ExtensionManifest,
  Logger,
  ManagedQueuePort,
  QueueJob,
} from "@ext/types";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { fileTypeFromBuffer } from "file-type";
import { createConvertStepHandler } from "./convertStep";
import { buildImageParts, OCR_SYSTEM_PROMPT } from "./ocr";

/** MIME types supported for conversion. */
const SUPPORTED_MIME_PREFIXES = ["image/"] as const;
const SUPPORTED_MIME_EXACT = new Set(["application/pdf"]);

/**
 * TypeBox schema for the convert POST payload.
 *
 * Inputs are always supplied as base64-encoded bytes:
 * - `data` - array of base64-encoded file contents (required)
 * - `filenames` - optional display names, positionally aligned with `data`
 *
 * When multiple inputs are supplied, they are merged into a single conversion:
 * all images are sent to the vision model together as pages of one document.
 */
const ConvertPayloadSchema = Type.Object({
  data: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    description: "Base64-encoded file contents, merged into one conversion",
  }),
  filenames: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      description:
        "Display filenames for the `data` inputs, positionally aligned. Used only for job labels/logs; does not affect conversion.",
    }),
  ),
  prompt: Type.Optional(
    Type.String({ minLength: 1, description: "Custom system prompt to override the default OCR instructions" }),
  ),
});

/** A single resolved conversion input: an absolute temp-file path plus its detected MIME type. */
interface ConvertInput {
  /** Absolute path to the temp file holding the decoded bytes. */
  filePath: string;
  /** Detected MIME type. */
  mimeType: string;
  /**
   * Human-friendly name for job labels, logs, and session metadata. The bytes
   * are written to a generically named temp file, so this preserves the
   * caller's original filename. Falls back to the temp file basename.
   */
  displayName: string;
}

/** Job data for a conversion queue job. */
interface ConvertJobData {
  /** Ordered list of inputs to merge into a single conversion. */
  inputs: ConvertInput[];
  /** Optional custom system prompt overriding the default OCR instructions. */
  prompt?: string;
}

/** Result returned by the conversion queue processor. */
interface ConvertJobResult {
  /** The extracted markdown text. */
  markdown: string;
}

/** Pending HTTP request waiting for a conversion job to complete. */
interface PendingRequest {
  resolve: (result: ConvertJobResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Checks whether a MIME type is supported for conversion.
 *
 * @param mime - The MIME type string to check
 * @returns `true` if the type is supported
 */
function isSupportedMime(mime: string): boolean {
  if (SUPPORTED_MIME_EXACT.has(mime)) return true;
  return SUPPORTED_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
}

/** Maps MIME types to file extensions for temp file creation. */
const MIME_TO_EXT: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
  "image/heic": ".heic",
  "image/heif": ".heif",
};

/**
 * Writes file bytes to a temporary file with the correct extension.
 * Uses `mkdtempSync` to create an isolated temp directory, avoiding filename collisions.
 *
 * @param bytes - File content
 * @param mimeType - Detected MIME type (used to choose file extension)
 * @returns Absolute path to the temporary file
 */
async function writeBytesToTempFile(bytes: Uint8Array, mimeType: string): Promise<string> {
  const ext = MIME_TO_EXT[mimeType] ?? ".bin";
  const dir = mkdtempSync(path.join(tmpdir(), "palim-convert-"));
  const tempPath = path.join(dir, `input${ext}`);
  await Bun.write(tempPath, bytes);
  return tempPath;
}

/** Structured outcome of resolving a single conversion input. */
type ResolveResult =
  | { ok: true; input: ConvertInput; tempFile: string }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Resolves file bytes by detecting their type and writing them to a temp file.
 *
 * @param bytes - File content
 * @param displayName - Optional original filename for labels/logs; falls back to the temp file basename
 * @returns A resolve result with either the resolved input (and temp file path) or an error response
 */
async function resolveBytesInput(bytes: Uint8Array, displayName?: string): Promise<ResolveResult> {
  const typeResult = await fileTypeFromBuffer(bytes);
  const mimeType = typeResult?.mime ?? "application/octet-stream";

  if (!isSupportedMime(mimeType)) {
    return { ok: false, status: 415, body: { error: `Unsupported file type: ${mimeType}`, mimeType } };
  }

  const tempFile = await writeBytesToTempFile(bytes, mimeType);
  return {
    ok: true,
    input: { filePath: tempFile, mimeType, displayName: displayName ?? path.basename(tempFile) },
    tempFile,
  };
}

/**
 * Removes the temp directories created while resolving inputs.
 *
 * @param tempFiles - Temp file paths from {@link resolveBytesInput}
 */
function cleanupTempFiles(tempFiles: string[]): void {
  for (const tempFile of tempFiles) {
    try {
      rmSync(path.dirname(tempFile), { recursive: true });
    } catch {}
  }
}

const manifest = {
  name: "converter",
  version: "1.3.0",
  description: "Converts files (PDFs, images) to markdown via vision LLM",
  settingsSchema: Type.Object({
    resizeImagePx: Type.Number({
      title: "Image Size",
      description: "Maximum dimension to resize images to before sending to vision model",
      default: 800,
      minimum: 100,
    }),
    conversionTimeoutMs: Type.Number({
      title: "Timeout",
      description: "Timeout for the conversion to complete in milliseconds",
      default: 5 * 60 * 1000,
      minimum: 1,
    }),
  }),
} satisfies ExtensionManifest;

/**
 * Creates a fresh Converter extension instance.
 *
 * @returns An {@link Extension} object ready to be loaded by the registry
 */
export function createExtension(): Extension {
  let logger: Logger;
  const mutableState: {
    queue: ManagedQueuePort<ConvertJobData> | null;
    pending: Map<string, PendingRequest>;
  } = {
    queue: null,
    pending: new Map(),
  };

  /**
   * Enqueues a conversion job and waits for its result.
   *
   * @param inputs - Resolved inputs (temp files), converted as one document
   * @param prompt - Optional prompt replacing the default OCR instructions
   * @param timeoutMs - How long to wait for the job
   * @returns The job result
   * @throws When the job fails, times out, or the extension shuts down
   */
  async function enqueueAndWait(
    inputs: ConvertInput[],
    prompt: string | undefined,
    timeoutMs: number,
  ): Promise<ConvertJobResult> {
    const label =
      inputs.length === 1
        ? inputs[0]!.displayName
        : `${inputs.length} inputs (${inputs.map((input) => input.displayName).join(", ")})`;
    const jobData: ConvertJobData = { inputs };
    if (prompt) jobData.prompt = prompt;
    const jobId = await mutableState.queue!.add(`Convert: ${label}`, jobData);

    return new Promise<ConvertJobResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        mutableState.pending.delete(jobId);
        reject(new Error("Conversion timed out"));
      }, timeoutMs);
      mutableState.pending.set(jobId, { resolve, reject, timer });
    });
  }

  /** Bound in `initialize` (needs the extension config for the timeout). */
  let runConversion: (inputs: ConvertInput[], prompt?: string) => Promise<ConvertJobResult>;

  return {
    manifest,

    async initialize(ctx: ExtensionContext) {
      logger = ctx.log;
      runConversion = (inputs, prompt) =>
        enqueueAndWait(inputs, prompt, ctx.config.get<number>("CONVERSION_TIMEOUT_MS", 5 * 60 * 1000));

      // --- Conversion queue ---
      mutableState.queue = ctx.queues.create<ConvertJobData, ConvertJobResult>(
        "jobs",
        async (job: QueueJob<ConvertJobData>): Promise<ConvertJobResult> => {
          const { inputs, prompt } = job.data;
          const filenames = inputs.map((input) => input.displayName);

          await job.log(
            inputs.length === 1
              ? `Converting ${filenames[0]} (${inputs[0]!.mimeType})`
              : `Converting ${inputs.length} inputs as one document: ${filenames.join(", ")}`,
          );

          const resizeImagePx = ctx.config.get<number>("RESIZE_IMAGE_PX", 800);

          // Collect image parts from every input, preserving input order.
          // A single input may itself yield multiple parts (e.g. multi-page PDF).
          const imageParts: Awaited<ReturnType<typeof buildImageParts>> = [];
          for (const input of inputs) {
            const parts = await buildImageParts(input.filePath, resizeImagePx);
            imageParts.push(...parts);
          }

          await job.log(`Prepared ${imageParts.length} image(s) for vision model`);

          const systemPrompt = prompt ?? OCR_SYSTEM_PROMPT;

          // Interleave page markers with image parts so the LLM preserves page order
          const contentParts: (TextContent | ImageContent)[] = [
            {
              type: "text",
              text: prompt
                ? "Process the provided image(s) according to the system instructions."
                : "Extract all text from the provided image(s). Return only the extracted markdown content.",
            },
          ];

          await job.log(`**System Prompt:**\n\n${systemPrompt}`);

          for (let i = 0; i < imageParts.length; i++) {
            if (imageParts.length > 1) {
              contentParts.push({ type: "text", text: `--- Page ${i + 1} of ${imageParts.length} ---` });
            }
            contentParts.push(imageParts[i]!);
          }

          const message: AgentMessage = {
            role: "user",
            content: contentParts,
            timestamp: Date.now(),
          };

          // Create a session for this conversion run and append the user message
          const session = ctx.sessions.create({
            source: "converter",
            metadata: {
              filePaths: inputs.map((input) => input.filePath),
              mimeTypes: inputs.map((input) => input.mimeType),
            },
          });
          session.append(message);

          const result: AgentProcessorResult = await ctx.agent.run(job, {
            systemPrompt,
            tools: [],
            thinkingLevel: "low",
            sessionId: session.id,
            intent: "vision",
          });

          await job.log("Conversion complete");

          return { markdown: result.answer };
        },
        {
          concurrency: 1,
          removeOnComplete: false,
          removeOnFail: false,
          useLocks: false,
          stallConfig: { stallInterval: 1000 * 60 * 5, maxStalls: 1, gracePeriod: 15000, enabled: true },
        },
      );

      // --- Wire completed/failed events to resolve pending HTTP requests ---
      mutableState.queue.onEvent("completed", (event) => {
        const { jobId } = event;
        // The completed event from bunqueue carries `returnvalue` at runtime
        const returnvalue = (event as { returnvalue?: ConvertJobResult }).returnvalue;
        const pending = mutableState.pending.get(jobId);
        if (pending) {
          clearTimeout(pending.timer);
          mutableState.pending.delete(jobId);
          if (returnvalue) {
            pending.resolve(returnvalue);
          } else {
            pending.reject(new Error("Conversion completed but no result returned"));
          }
        }
      });

      mutableState.queue.onEvent("failed", (event) => {
        const { jobId, failedReason } = event;
        const pending = mutableState.pending.get(jobId);
        if (pending) {
          clearTimeout(pending.timer);
          mutableState.pending.delete(jobId);
          pending.reject(new Error(failedReason || "Conversion failed"));
        }
      });

      // --- `convert` workflow step: a work-dir file to markdown, no agent step needed ---
      ctx.stepTypes.register(
        "convert",
        createConvertStepHandler(async (bytes, filename, prompt) => {
          const resolved = await resolveBytesInput(bytes, filename);
          if (!resolved.ok) throw new Error(String(resolved.body.error));
          try {
            return (await runConversion([resolved.input], prompt)).markdown;
          } finally {
            cleanupTempFiles([resolved.tempFile]);
          }
        }),
      );

      // --- POST /ext/converter/convert ---
      ctx.routes.register("POST", "convert", async (elysiaCtx) => {
        try {
          // Use Elysia's already-parsed body. Reading `elysiaCtx.request.json()`
          // here would throw "Body already used" because Elysia has already
          // consumed the request stream to populate `elysiaCtx.body`.
          const body = elysiaCtx.body;

          if (!Value.Check(ConvertPayloadSchema, body)) {
            const errorMsg = formatValidationErrors(ConvertPayloadSchema, body);
            return new Response(JSON.stringify({ error: `Validation failed: ${errorMsg}` }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }

          const payload = body as {
            data: string[];
            filenames?: string[];
            prompt?: string;
          };

          const dataInputs = payload.data;
          const dataFilenames = payload.filenames ?? [];

          // Resolve every input. Track temp files so we can clean them up regardless of outcome.
          const inputs: ConvertInput[] = [];
          const tempFiles: string[] = [];

          for (let i = 0; i < dataInputs.length; i++) {
            const resolveResult = await resolveBytesInput(Buffer.from(dataInputs[i]!, "base64"), dataFilenames[i]);
            if (!resolveResult.ok) {
              cleanupTempFiles(tempFiles);
              return new Response(JSON.stringify(resolveResult.body), {
                status: resolveResult.status,
                headers: { "Content-Type": "application/json" },
              });
            }
            inputs.push(resolveResult.input);
            tempFiles.push(resolveResult.tempFile);
          }

          let result: ConvertJobResult;
          try {
            result = await runConversion(inputs, payload.prompt);
          } finally {
            cleanupTempFiles(tempFiles);
          }

          return new Response(JSON.stringify({ markdown: result.markdown }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error("Conversion failed:", message);
          return new Response(JSON.stringify({ error: message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      });
    },

    async shutdown() {
      // Reject all pending requests
      for (const [, pending] of mutableState.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Extension shutting down"));
      }
      mutableState.pending.clear();

      if (mutableState.queue) {
        await mutableState.queue.close();
        mutableState.queue = null;
      }
    },
  };
}

export default createExtension();
