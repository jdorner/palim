/**
 * Outgoing message delivery for the Telegram extension.
 *
 * Markdown is sent as a rich message (`sendRichMessage`, Bot API 10.1+), whose
 * Markdown dialect is GitHub Flavored Markdown compatible, so agent output can be
 * passed through unchanged without MarkdownV2 escaping. If Telegram rejects the
 * rich message (unsupported chat, malformed content), delivery falls back to
 * plain text. Plain text is split into chunks that fit the `sendMessage` limit.
 */

import { type Bot, TelegramApiError } from "node-telegram-bot-api";

/** How outgoing message text is rendered. */
export type MessageFormat = "markdown" | "plain";

/** Default format for outgoing messages. */
export const DEFAULT_MESSAGE_FORMAT: MessageFormat = "markdown";

/** Maximum `sendMessage` text length. */
export const PLAIN_TEXT_LIMIT = 4096;

/** Maximum rich message text length. */
export const RICH_MESSAGE_LIMIT = 32768;

/** HTTP status Telegram returns when rate limiting; falling back would hit the same limit. */
const TOO_MANY_REQUESTS = 429;

/** Minimal logger used to report a fallback to plain text. */
interface DeliveryLogger {
  warn(...args: unknown[]): void;
}

/**
 * Normalizes a raw config value to a {@link MessageFormat}.
 *
 * @param raw - Value from settings or env (`"markdown"` or `"plain"`)
 * @returns `"plain"` when explicitly configured, otherwise the default
 */
export function parseMessageFormat(raw: unknown): MessageFormat {
  return raw === "plain" ? "plain" : DEFAULT_MESSAGE_FORMAT;
}

/**
 * Splits text into chunks of at most `limit` UTF-16 code units, preferring
 * paragraph, then line, then word boundaries. Surrogate pairs are never cut.
 *
 * @param text - The text to split
 * @param limit - Maximum chunk length
 * @returns The chunks in order; a single chunk when the text already fits
 */
export function splitMessage(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let rest = text;

  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1);
    let cut = -1;
    for (const separator of ["\n\n", "\n", " "]) {
      const index = window.lastIndexOf(separator);
      if (index > 0) {
        cut = index;
        break;
      }
    }

    if (cut === -1) {
      // No boundary: hard cut, stepping back if it would split a surrogate pair.
      cut = limit;
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut--;
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    } else {
      chunks.push(rest.slice(0, cut).trimEnd());
      rest = rest.slice(cut).replace(/^\s+/, "");
    }
  }

  if (rest.length > 0 || chunks.length === 0) chunks.push(rest);
  return chunks;
}

/**
 * Sends a message to a chat in the given format.
 *
 * Markdown is sent as one or more rich messages. A Telegram API rejection of a
 * rich message (other than rate limiting) falls back to plain text for the
 * remaining content. Network errors are rethrown rather than retried, since
 * the message may already have been delivered.
 *
 * @param bot - Connected bot instance
 * @param chatId - Target chat ID
 * @param text - Message text (Markdown when `format` is `"markdown"`)
 * @param format - How to render the text
 * @param logger - Receives a warning when falling back to plain text
 * @throws If Telegram rejects the plain-text send or the request fails
 */
export async function deliverMessage(
  bot: Bot,
  chatId: number,
  text: string,
  format: MessageFormat,
  logger?: DeliveryLogger,
): Promise<void> {
  if (format === "markdown") {
    const chunks = splitMessage(text, RICH_MESSAGE_LIMIT);
    for (const [index, chunk] of chunks.entries()) {
      try {
        await bot.api.sendRichMessage({ chat_id: chatId, rich_message: { markdown: chunk } });
      } catch (err) {
        if (!(err instanceof TelegramApiError) || err.errorCode === TOO_MANY_REQUESTS) throw err;
        logger?.warn(`Rich message rejected for chat ${chatId} (${err.description}); sending as plain text`);
        await sendPlain(bot, chatId, chunks.slice(index).join("\n\n"));
        return;
      }
    }
    return;
  }

  await sendPlain(bot, chatId, text);
}

/** Sends text with `sendMessage`, split to fit its length limit. */
async function sendPlain(bot: Bot, chatId: number, text: string): Promise<void> {
  for (const chunk of splitMessage(text, PLAIN_TEXT_LIMIT)) {
    await bot.api.sendMessage({ chat_id: chatId, text: chunk });
  }
}
