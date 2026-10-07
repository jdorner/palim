/**
 * Image handling for incoming Telegram messages: picks the image attachments
 * of a message, downloads them via the Bot API, and builds the user message
 * content passed to the LLM.
 */

import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { Bot, Message } from "node-telegram-bot-api";

/** Default and upper bound for the image size limit (Bot API `getFile` cap). */
export const MAX_IMAGE_SIZE_MB = 20;

const BYTES_PER_MB = 1024 * 1024;
const TELEGRAM_FILE_ROOT = "https://api.telegram.org/file";

/** An image attachment referenced by a Telegram message, not yet downloaded. */
export interface TelegramImageRef {
  /** Telegram file ID used with `getFile`. */
  fileId: string;
  /** MIME type of the image. */
  mimeType: string;
  /** File size in bytes, when Telegram reports it. */
  fileSize?: number;
}

/** Raised when an image exceeds the configured size limit. */
export class ImageTooLargeError extends Error {
  constructor(
    readonly sizeBytes: number,
    readonly limitMb: number,
  ) {
    super(`Image too large (${formatMb(sizeBytes)} MB, limit ${limitMb} MB)`);
    this.name = "ImageTooLargeError";
  }
}

/**
 * Normalizes a configured image size limit, falling back to
 * {@link MAX_IMAGE_SIZE_MB} for missing, non-numeric, or out-of-range values.
 *
 * @param raw - Raw setting value (number or numeric string)
 * @returns The limit in MB, within `(0, MAX_IMAGE_SIZE_MB]`
 */
export function parseMaxImageSizeMb(raw: unknown): number {
  const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || value <= 0) return MAX_IMAGE_SIZE_MB;
  return Math.min(value, MAX_IMAGE_SIZE_MB);
}

/**
 * Returns the image attachments of a message: the largest size of a photo,
 * or a document whose MIME type is an image (sent "as file", uncompressed).
 *
 * @param msg - The incoming Telegram message
 * @returns Image references (empty when the message carries no image)
 */
export function getImageRefs(msg: Message): TelegramImageRef[] {
  const refs: TelegramImageRef[] = [];

  // Telegram lists photo sizes in ascending order; the last one is the largest.
  const photo = msg.photo?.at(-1);
  if (photo) {
    refs.push({ fileId: photo.file_id, mimeType: "image/jpeg", fileSize: photo.file_size });
  }

  const doc = msg.document;
  if (doc?.mime_type?.startsWith("image/")) {
    refs.push({ fileId: doc.file_id, mimeType: doc.mime_type, fileSize: doc.file_size });
  }

  return refs;
}

/**
 * Builds user message content from text and images. Text-only messages stay
 * plain strings so existing sessions keep their shape.
 *
 * @param text - Message text or caption (may be empty)
 * @param images - Downloaded images
 * @returns Content for a pi-ai user message
 */
export function buildUserContent(text: string, images: ImageContent[]): string | (TextContent | ImageContent)[] {
  if (images.length === 0) return text;
  return text ? [{ type: "text", text }, ...images] : [...images];
}

/**
 * Downloads an image via the Bot API and returns it as base64 image content.
 * The file URL contains the bot token and is never logged or included in errors.
 *
 * @param bot - Connected bot instance
 * @param token - Bot token (for the file download URL)
 * @param ref - The image to download
 * @param limitMb - Maximum accepted size in MB
 * @returns The image as pi-ai image content
 * @throws {ImageTooLargeError} If the image exceeds `limitMb`
 * @throws If `getFile` or the download fails
 */
export async function downloadImage(
  bot: Bot,
  token: string,
  ref: TelegramImageRef,
  limitMb: number,
): Promise<ImageContent> {
  const limitBytes = limitMb * BYTES_PER_MB;
  if (ref.fileSize !== undefined && ref.fileSize > limitBytes) {
    throw new ImageTooLargeError(ref.fileSize, limitMb);
  }

  const file = await bot.api.getFile({ file_id: ref.fileId });
  if (file.file_size !== undefined && file.file_size > limitBytes) {
    throw new ImageTooLargeError(file.file_size, limitMb);
  }
  if (!file.file_path) {
    throw new Error("Telegram returned no file path for the image");
  }

  const res = await fetch(`${TELEGRAM_FILE_ROOT}/bot${token}/${file.file_path}`);
  if (!res.ok) {
    throw new Error(`Image download failed with HTTP ${res.status}`);
  }

  const bytes = await res.bytes();
  if (bytes.byteLength > limitBytes) {
    throw new ImageTooLargeError(bytes.byteLength, limitMb);
  }

  return { type: "image", data: bytes.toBase64(), mimeType: ref.mimeType };
}

function formatMb(bytes: number): string {
  return (bytes / BYTES_PER_MB).toFixed(1);
}
