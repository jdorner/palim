/**
 * OCR utilities - reads image/PDF files and base64-encodes them
 * as vision content parts for LLM processing.
 */

import path from "node:path";
import decode from "heic-decode";
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
  ".heic": "image/heic",
  ".heif": "image/heif",
};

/** Extensions that require HEIC decoding before processing. */
const HEIC_EXTENSIONS = new Set([".heic", ".heif"]);

/**
 * Encodes raw RGBA pixel data as an uncompressed 32-bit BMP buffer.
 * BMP stores rows bottom-to-top, so the row order is flipped.
 *
 * @param data - RGBA pixel data (4 bytes per pixel)
 * @param width - Image width in pixels
 * @param height - Image height in pixels
 * @returns A Buffer containing a valid BMP file
 */
function rgbaToBmp(data: Uint8ClampedArray, width: number, height: number): Buffer {
  const rowSize = width * 4;
  const pixelDataSize = rowSize * height;
  const headerSize = 14 + 108; // BMP file header (14) + BITMAPV4HEADER (108)
  const fileSize = headerSize + pixelDataSize;

  const buf = Buffer.alloc(fileSize);

  // -- BMP File Header (14 bytes) --
  buf.write("BM", 0); // Signature
  buf.writeUInt32LE(fileSize, 2); // File size
  buf.writeUInt32LE(0, 6); // Reserved
  buf.writeUInt32LE(headerSize, 10); // Pixel data offset

  // -- BITMAPV4HEADER (108 bytes) - supports alpha channel --
  buf.writeUInt32LE(108, 14); // Header size
  buf.writeInt32LE(width, 18); // Width
  buf.writeInt32LE(-height, 22); // Height (negative = top-down row order)
  buf.writeUInt16LE(1, 26); // Color planes
  buf.writeUInt16LE(32, 28); // Bits per pixel
  buf.writeUInt32LE(3, 30); // Compression: BI_BITFIELDS
  buf.writeUInt32LE(pixelDataSize, 34); // Image size
  buf.writeInt32LE(2835, 38); // X pixels per meter (~72 DPI)
  buf.writeInt32LE(2835, 42); // Y pixels per meter
  buf.writeUInt32LE(0, 46); // Colors used
  buf.writeUInt32LE(0, 50); // Important colors

  // Channel masks (RGBA): R=0x00FF0000, G=0x0000FF00, B=0x000000FF, A=0xFF000000
  buf.writeUInt32LE(0x00ff0000, 54); // Red mask
  buf.writeUInt32LE(0x0000ff00, 58); // Green mask
  buf.writeUInt32LE(0x000000ff, 62); // Blue mask
  buf.writeUInt32LE(0xff000000, 66); // Alpha mask

  // Color space type: LCS_sRGB
  buf.writeUInt32LE(0x73524742, 70);
  // Remaining V4 fields (endpoints + gamma) are zero-filled by Buffer.alloc

  // -- Pixel data (BGRA order for BMP) --
  for (let i = 0; i < data.length; i += 4) {
    const offset = headerSize + i;
    buf[offset] = data[i + 2]!; // B
    buf[offset + 1] = data[i + 1]!; // G
    buf[offset + 2] = data[i]!; // R
    buf[offset + 3] = data[i + 3]!; // A
  }

  return buf;
}

/**
 * Decodes a HEIC/HEIF file to raw RGBA pixel data using heic-decode,
 * then converts it to a PNG buffer via Bun.Image.
 *
 * @param filePath - Absolute path to the HEIC/HEIF file
 * @param imageSize - Maximum dimension to resize the output to
 * @returns Base64-encoded PNG string
 */
async function decodeHeicToPngBase64(filePath: string, imageSize: number): Promise<string> {
  const fileBuffer = await Bun.file(filePath).arrayBuffer();
  const { width, height, data } = await decode({ buffer: new Uint8Array(fileBuffer) });

  // heic-decode returns raw RGBA pixel data - encode as BMP so Bun.Image can read it
  const bmpBuffer = rgbaToBmp(data, width, height);
  return new Bun.Image(bmpBuffer).resize(imageSize).png().toBase64();
}

/**
 * Reads a file and returns base64-encoded image content parts suitable
 * for injection into an {@link AgentMessage}.
 *
 * All output is encoded as PNG (lossless) to maximize OCR accuracy.
 * For PDFs, each page is rasterized via `pdf-to-img` and re-encoded as PNG.
 * For HEIC/HEIF, raw pixels are decoded via heic-decode and encoded as PNG.
 * For other images, the file is resized and re-encoded as PNG.
 *
 * @param filePath - Absolute path to the image or PDF file
 * @param imageSize - Maximum dimension to resize images to
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
      const data = await new Bun.Image(pageBuffer).resize(imageSize).png().toBase64();
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

  // HEIC/HEIF files need explicit decoding since Bun.Image cannot read them directly
  if (HEIC_EXTENSIONS.has(ext)) {
    const data = await decodeHeicToPngBase64(filePath, imageSize);
    return [{ type: "image", data, mimeType: "image/png" }];
  }

  const data = await new Bun.Image(filePath).resize(imageSize).png().toBase64();
  return [{ type: "image", data, mimeType: "image/png" }];
}
