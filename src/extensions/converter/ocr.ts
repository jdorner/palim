/**
 * OCR utilities - reads image/PDF files and base64-encodes them
 * as vision content parts for LLM processing.
 */

import path from "node:path";
import { pdf } from "pdf-to-img";

/** System prompt for OCR processing. */
export const OCR_SYSTEM_PROMPT = [
  "You are a document OCR agent. Your sole task is to extract text from images and PDFs.",
  "",
  "Instructions:",
  "- Extract ALL visible text from the provided image(s)",
  "- Preserve the document structure using markdown: headings, lists, tables, paragraphs",
  "- Do NOT add commentary, interpretation, or summaries - output only the extracted content",
  "- Do NOT translate unless told so",
  "- If the image contains a table, reproduce it as a markdown table",
  "- If multiple pages are provided, separate them with a horizontal rule (---)",
].join("\n");

/** Maps common image extensions to MIME types. */
const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
};

/**
 * Reads a file and returns base64-encoded image content parts suitable
 * for injection into an {@link AgentMessage}.
 *
 * For PDFs, each page is converted to a PNG buffer via `pdf-to-img`.
 * For images, the raw bytes are read and base64-encoded directly.
 *
 * @param filePath - Absolute path to the image or PDF file
 * @returns Array of image content parts
 * @throws If the file cannot be read or the PDF cannot be parsed
 */
export async function buildImageParts(
  filePath: string,
  imageSize: number,
): Promise<{ type: "image"; data: string; mimeType: string }[]> {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".pdf") {
    const parts: { type: "image"; data: string; mimeType: string }[] = [];
    const doc = await pdf(filePath);

    for await (const pageBuffer of doc) {
      const data = await new Bun.Image(pageBuffer).resize(imageSize).jpeg().toBase64();
      parts.push({
        type: "image",
        data,
        mimeType: "image/png",
      });
    }
    return parts;
  }

  const mimeType = MIME_TYPES[ext];
  if (typeof mimeType === "undefined") {
    throw new Error(`Unsupported file type: ${ext}`);
  }

  const data = await new Bun.Image(filePath).resize(imageSize).jpeg().toBase64();
  return [{ type: "image", data, mimeType }];
}
