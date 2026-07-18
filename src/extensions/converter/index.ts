/**
 * Converter extension - converts files (PDFs, images) to markdown text
 * using a vision LLM agent.
 *
 * Exposes a `POST /ext/converter/convert` endpoint that accepts either:
 * - A file `path` (relative to work directory) for filesystem-based input
 * - A base64-encoded `data` string for piped/stdin input
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
import { fileTypeFromBuffer, fileTypeFromFile } from "file-type";
import { buildImageParts, OCR_SYSTEM_PROMPT } from "./ocr";

/** MIME types supported for conversion. */
const SUPPORTED_MIME_PREFIXES = ["image/"] as const;
const SUPPORTED_MIME_EXACT = new Set(["application/pdf"]);

/** TypeBox schema for the convert POST payload. Accepts either `path` or `data`. */
const ConvertPayloadSchema = Type.Object({
  path: Type.Optional(Type.String({ minLength: 1, description: "File path relative to the work directory" })),
  data: Type.Optional(Type.String({ minLength: 1, description: "Base64-encoded file content (for stdin/pipe input)" })),
  prompt: Type.Optional(
    Type.String({ minLength: 1, description: "Custom system prompt to override the default OCR instructions" }),
  ),
});

/** Job data for a conversion queue job. */
interface ConvertJobData {
  /** Absolute path to the file to convert. */
  filePath: string;
  /** Detected MIME type. */
  mimeType: string;
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
};

/**
 * Writes base64-encoded data to a temporary file with the correct extension.
 * Uses `mkdtempSync` to create an isolated temp directory, avoiding filename collisions.
 *
 * @param data - Base64-encoded file content
 * @param mimeType - Detected MIME type (used to choose file extension)
 * @returns Absolute path to the temporary file
 */
async function writeDataToTempFile(data: string, mimeType: string): Promise<string> {
  const ext = MIME_TO_EXT[mimeType] ?? ".bin";
  const dir = mkdtempSync(path.join(tmpdir(), "palim-convert-"));
  const tempPath = path.join(dir, `input${ext}`);
  const buffer = Buffer.from(data, "base64");
  await Bun.write(tempPath, buffer);
  return tempPath;
}

const manifest = {
  name: "converter",
  version: "1.0.0",
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

  return {
    manifest,

    async initialize(ctx: ExtensionContext) {
      logger = ctx.log;

      // --- Conversion queue ---
      mutableState.queue = ctx.createQueue<ConvertJobData, ConvertJobResult>(
        "jobs",
        async (job: QueueJob<ConvertJobData>): Promise<ConvertJobResult> => {
          const { filePath, mimeType, prompt } = job.data;
          const filename = path.basename(filePath);

          await job.log(`Converting ${filename} (${mimeType})`);

          const resizeImagePx = ctx.getConfig<number>("RESIZE_IMAGE_PX", 800);
          const imageParts = await buildImageParts(filePath, resizeImagePx);

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
            metadata: { filePath, mimeType },
          });
          session.append(message);

          const result: AgentProcessorResult = await ctx.runAgent(job, {
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

      // --- POST /ext/converter/convert ---
      ctx.registerRoute("POST", "convert", async (elysiaCtx) => {
        try {
          const body = await elysiaCtx.request.json();

          if (!Value.Check(ConvertPayloadSchema, body)) {
            const errorMsg = formatValidationErrors(ConvertPayloadSchema, body);
            return new Response(JSON.stringify({ error: `Validation failed: ${errorMsg}` }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }

          const payload = body as { path?: string; data?: string; prompt?: string };

          // Must provide either path or data
          if (!payload.path && !payload.data) {
            return new Response(JSON.stringify({ error: "Either 'path' or 'data' must be provided" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }

          let resolved: string;
          let mimeType: string;
          let tempFile: string | null = null;

          if (payload.path) {
            // --- File path mode ---
            const absolutePath = path.isAbsolute(payload.path) ? payload.path : path.resolve(ctx.workDir, payload.path);

            resolved = path.resolve(absolutePath);
            if (!resolved.startsWith(ctx.workDir)) {
              return new Response(JSON.stringify({ error: "Access denied: path outside work directory" }), {
                status: 403,
                headers: { "Content-Type": "application/json" },
              });
            }

            const file = Bun.file(resolved);
            if (!(await file.exists())) {
              return new Response(JSON.stringify({ error: `File not found: ${payload.path}` }), {
                status: 404,
                headers: { "Content-Type": "application/json" },
              });
            }

            const typeResult = await fileTypeFromFile(resolved);
            mimeType = typeResult?.mime ?? "application/octet-stream";
          } else {
            // --- Base64 data mode (stdin/pipe) ---
            const buffer = Buffer.from(payload.data!, "base64");
            const typeResult = await fileTypeFromBuffer(buffer);
            mimeType = typeResult?.mime ?? "application/octet-stream";

            if (!isSupportedMime(mimeType)) {
              return new Response(JSON.stringify({ error: `Unsupported file type: ${mimeType}`, mimeType }), {
                status: 415,
                headers: { "Content-Type": "application/json" },
              });
            }

            // Write to temp file for processing by buildImageParts
            tempFile = await writeDataToTempFile(payload.data!, mimeType);
            resolved = tempFile;
          }

          if (!isSupportedMime(mimeType)) {
            return new Response(JSON.stringify({ error: `Unsupported file type: ${mimeType}`, mimeType }), {
              status: 415,
              headers: { "Content-Type": "application/json" },
            });
          }

          // Enqueue conversion job and wait for result
          const filename = tempFile ? `stdin-${Date.now()}` : path.basename(resolved);
          const jobData: ConvertJobData = { filePath: resolved, mimeType };
          if (payload.prompt) {
            jobData.prompt = payload.prompt;
          }
          const jobId = await mutableState.queue!.add(`Convert: ${filename}`, jobData);

          const conversionTimeoutMs = ctx.getConfig<number>("CONVERSION_TIMEOUT_MS", 5 * 60 * 1000);

          const result = await new Promise<ConvertJobResult>((resolve, reject) => {
            const timer = setTimeout(() => {
              mutableState.pending.delete(jobId);
              reject(new Error("Conversion timed out"));
            }, conversionTimeoutMs);

            mutableState.pending.set(jobId, { resolve, reject, timer });
          });

          // Clean up temp file and directory if we created one
          if (tempFile) {
            try {
              rmSync(path.dirname(tempFile), { recursive: true });
            } catch {}
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
