import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Bot, Message } from "node-telegram-bot-api";
import {
  buildUserContent,
  downloadImage,
  getImageRefs,
  ImageTooLargeError,
  MAX_IMAGE_SIZE_MB,
  parseMaxImageSizeMb,
} from "./images";

const MB = 1024 * 1024;
const TOKEN = "123:secret-token";

/** Builds a minimal Telegram message with the given fields. */
function message(fields: Partial<Message>): Message {
  return { message_id: 1, date: 0, chat: { id: 42, type: "private" }, ...fields } as Message;
}

/** Fake bot whose getFile returns the given file and records calls. */
function fakeBot(file: { file_path?: string; file_size?: number }): { bot: Bot; calls: string[] } {
  const calls: string[] = [];
  const bot = {
    api: {
      getFile: async ({ file_id }: { file_id: string }) => {
        calls.push(file_id);
        return { file_id, file_unique_id: "u", ...file };
      },
    },
  } as unknown as Bot;
  return { bot, calls };
}

describe("getImageRefs", () => {
  test("picks the largest photo size", () => {
    const refs = getImageRefs(
      message({
        photo: [
          { file_id: "small", file_unique_id: "s", width: 90, height: 90, file_size: 100 },
          { file_id: "large", file_unique_id: "l", width: 1280, height: 1280, file_size: 5000 },
        ],
      }),
    );
    expect(refs).toEqual([{ fileId: "large", mimeType: "image/jpeg", fileSize: 5000 }]);
  });

  test("accepts image documents and ignores other documents", () => {
    expect(
      getImageRefs(
        message({ document: { file_id: "doc", file_unique_id: "d", mime_type: "image/png", file_size: 7 } }),
      ),
    ).toEqual([{ fileId: "doc", mimeType: "image/png", fileSize: 7 }]);
    expect(
      getImageRefs(message({ document: { file_id: "pdf", file_unique_id: "p", mime_type: "application/pdf" } })),
    ).toEqual([]);
  });

  test("returns nothing for text messages", () => {
    expect(getImageRefs(message({ text: "hi" }))).toEqual([]);
  });
});

describe("buildUserContent", () => {
  const image = { type: "image" as const, data: "AAAA", mimeType: "image/jpeg" };

  test("keeps text-only content as a string", () => {
    expect(buildUserContent("hello", [])).toBe("hello");
  });

  test("puts the caption before the images", () => {
    expect(buildUserContent("look", [image, image])).toEqual([{ type: "text", text: "look" }, image, image]);
  });

  test("omits the text block when there is no caption", () => {
    expect(buildUserContent("", [image])).toEqual([image]);
  });
});

describe("parseMaxImageSizeMb", () => {
  test("accepts numbers and numeric strings", () => {
    expect(parseMaxImageSizeMb(5)).toBe(5);
    expect(parseMaxImageSizeMb("2.5")).toBe(2.5);
  });

  test("falls back to the default for invalid values", () => {
    for (const raw of [undefined, null, "", "abc", 0, -1]) {
      expect(parseMaxImageSizeMb(raw)).toBe(MAX_IMAGE_SIZE_MB);
    }
  });

  test("caps at the Bot API limit", () => {
    expect(parseMaxImageSizeMb(100)).toBe(MAX_IMAGE_SIZE_MB);
  });
});

describe("downloadImage", () => {
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
  });

  test("downloads the file and returns base64 image content", async () => {
    const { bot } = fakeBot({ file_path: "photos/file_1.jpg", file_size: 3 });
    const urls: string[] = [];
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(new Uint8Array([1, 2, 3]));
    }) as typeof fetch);

    const image = await downloadImage(bot, TOKEN, { fileId: "f1", mimeType: "image/jpeg" }, 1);

    expect(urls).toEqual([`https://api.telegram.org/file/bot${TOKEN}/photos/file_1.jpg`]);
    expect(image).toEqual({ type: "image", data: "AQID", mimeType: "image/jpeg" });
  });

  test("rejects oversized images before calling getFile", async () => {
    const { bot, calls } = fakeBot({ file_path: "x" });
    const err = await downloadImage(bot, TOKEN, { fileId: "f1", mimeType: "image/jpeg", fileSize: 3 * MB }, 2).catch(
      (e) => e,
    );

    expect(err).toBeInstanceOf(ImageTooLargeError);
    expect(err.message).toBe("Image too large (3.0 MB, limit 2 MB)");
    expect(calls).toEqual([]);
  });

  test("rejects oversized images reported by getFile", async () => {
    const { bot } = fakeBot({ file_path: "x", file_size: 3 * MB });
    const err = await downloadImage(bot, TOKEN, { fileId: "f1", mimeType: "image/jpeg" }, 2).catch((e) => e);
    expect(err).toBeInstanceOf(ImageTooLargeError);
  });

  test("does not leak the token in download errors", async () => {
    const { bot } = fakeBot({ file_path: "x" });
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
    );

    const err = await downloadImage(bot, TOKEN, { fileId: "f1", mimeType: "image/jpeg" }, 2).catch((e) => e);
    expect(err.message).toBe("Image download failed with HTTP 404");
    expect(err.message).not.toContain(TOKEN);
  });
});
