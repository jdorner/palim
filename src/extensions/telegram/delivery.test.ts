import { describe, expect, test } from "bun:test";
import { type Bot, NetworkError, TelegramApiError } from "node-telegram-bot-api";
import { deliverMessage, PLAIN_TEXT_LIMIT, parseMessageFormat, splitMessage } from "./delivery";

type SentCall = { method: "rich" | "plain"; text: string };

/** Fake bot that records sends; `richError` makes every rich send throw. */
function fakeBot(richError?: Error): { bot: Bot; calls: SentCall[] } {
  const calls: SentCall[] = [];
  const bot = {
    api: {
      sendRichMessage: async ({ rich_message }: { rich_message: { markdown: string } }) => {
        if (richError) throw richError;
        calls.push({ method: "rich", text: rich_message.markdown });
      },
      sendMessage: async ({ text }: { text: string }) => {
        calls.push({ method: "plain", text });
      },
    },
  } as unknown as Bot;
  return { bot, calls };
}

describe("parseMessageFormat", () => {
  test("defaults to markdown", () => {
    expect(parseMessageFormat(undefined)).toBe("markdown");
    expect(parseMessageFormat("bogus")).toBe("markdown");
  });

  test("accepts plain", () => {
    expect(parseMessageFormat("plain")).toBe("plain");
  });
});

describe("splitMessage", () => {
  test("returns short text as a single chunk", () => {
    expect(splitMessage("hello", 10)).toEqual(["hello"]);
    expect(splitMessage("", 10)).toEqual([""]);
  });

  test("prefers paragraph boundaries", () => {
    expect(splitMessage("aaaa\nbb\n\ncccc", 10)).toEqual(["aaaa\nbb", "cccc"]);
  });

  test("falls back to line, then word boundaries", () => {
    expect(splitMessage("aaaa\nbbbb cc", 8)).toEqual(["aaaa", "bbbb cc"]);
    expect(splitMessage("aaaa bbbb cc", 8)).toEqual(["aaaa", "bbbb cc"]);
  });

  test("hard-cuts text without boundaries", () => {
    expect(splitMessage("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  test("never splits a surrogate pair", () => {
    const chunks = splitMessage("abc😀def", 4);
    expect(chunks).toEqual(["abc", "😀de", "f"]);
  });

  test("keeps every chunk within the limit", () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i} ${"x".repeat(i % 40)}`).join("\n");
    const chunks = splitMessage(text, 100);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
  });
});

describe("deliverMessage", () => {
  test("sends markdown as a rich message", async () => {
    const { bot, calls } = fakeBot();
    await deliverMessage(bot, 1, "**hi**", "markdown");
    expect(calls).toEqual([{ method: "rich", text: "**hi**" }]);
  });

  test("sends plain format with sendMessage", async () => {
    const { bot, calls } = fakeBot();
    await deliverMessage(bot, 1, "**hi**", "plain");
    expect(calls).toEqual([{ method: "plain", text: "**hi**" }]);
  });

  test("chunks long plain text to the sendMessage limit", async () => {
    const { bot, calls } = fakeBot();
    await deliverMessage(bot, 1, "x".repeat(PLAIN_TEXT_LIMIT + 10), "plain");
    expect(calls.map((c) => c.text.length)).toEqual([PLAIN_TEXT_LIMIT, 10]);
  });

  test("falls back to plain text when Telegram rejects the rich message", async () => {
    const { bot, calls } = fakeBot(new TelegramApiError(400, "Bad Request: can't parse"));
    const warnings: unknown[] = [];
    await deliverMessage(bot, 1, "**hi**", "markdown", { warn: (...args) => warnings.push(args) });
    expect(calls).toEqual([{ method: "plain", text: "**hi**" }]);
    expect(warnings.length).toBe(1);
  });

  test("rethrows rate limiting instead of falling back", async () => {
    const { bot, calls } = fakeBot(new TelegramApiError(429, "Too Many Requests"));
    await expect(deliverMessage(bot, 1, "hi", "markdown")).rejects.toBeInstanceOf(TelegramApiError);
    expect(calls).toEqual([]);
  });

  test("rethrows network errors instead of falling back", async () => {
    const { bot, calls } = fakeBot(new NetworkError("connection reset"));
    await expect(deliverMessage(bot, 1, "hi", "markdown")).rejects.toBeInstanceOf(NetworkError);
    expect(calls).toEqual([]);
  });
});
