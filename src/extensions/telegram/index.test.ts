/**
 * Tests the Telegram extension's chat allowlist against a fake bot: which
 * incoming messages reach the agent, and where the agent tool may send.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Extension, ExtensionContext } from "@ext/types";
import type { Bot, Message } from "node-telegram-bot-api";
import { createExtension } from "./index";

type Handler = (event: Record<string, unknown>) => unknown;
type ToolResult = { content: Array<{ text: string }> };
type Tool = { name: string; execute: (id: string, params: unknown) => Promise<ToolResult> };

/** A bot that records sends and lets the test deliver incoming messages. */
function createFakeBot() {
  let onMessage: ((ctx: { message: Message }) => unknown) | undefined;
  const sent: Array<{ chat_id: number; text?: string }> = [];
  const api = {
    sendMessage: async (args: { chat_id: number; text: string }) => {
      sent.push(args);
    },
    sendRichMessage: async (args: { chat_id: number; rich_message: { markdown: string } }) => {
      sent.push({ chat_id: args.chat_id, text: args.rich_message.markdown });
    },
    sendChatAction: async () => {},
  };
  const bot = {
    api,
    catch: () => {},
    on: (event: string, handler: (ctx: { message: Message }) => unknown) => {
      if (event === "message") onMessage = handler;
    },
    startPolling: () => new Promise<void>(() => {}),
    stop: () => {},
  };
  return {
    bot: bot as unknown as Bot,
    sent,
    /** Delivers a text message from a chat, as Telegram's long poll would. */
    async receive(chatId: number, text: string) {
      await onMessage?.({
        message: { chat: { id: chatId, type: "private" }, from: { id: chatId }, text } as unknown as Message,
      });
    },
  };
}

/** A minimal extension context with the given settings (keyed like `ctx.config.get`). */
function createFakeContext(config: Record<string, unknown>) {
  const enqueued: string[] = [];
  const warnings: string[] = [];
  const tools: Tool[] = [];
  const handlers = new Map<string, Handler[]>();
  const session = { id: "session-1", append: () => {} };
  const ctx = {
    log: { info: () => {}, debug: () => {}, error: () => {}, warn: (msg: string) => warnings.push(msg) },
    secrets: { get: async () => "bot-token" },
    config: { get: (key: string) => config[key] },
    sessions: { getOrCreate: () => session },
    agent: {
      enqueue: async (name: string) => {
        enqueued.push(name);
        return `job-${enqueued.length}`;
      },
    },
    events: {
      on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    },
    tools: { register: (tool: Tool) => tools.push(tool) },
    stepTypes: { register: () => {} },
  };
  return {
    ctx: ctx as unknown as ExtensionContext,
    enqueued,
    warnings,
    tool: (name: string) => tools.find((t) => t.name === name)!,
    emit: (name: string, event: Record<string, unknown>) => {
      for (const handler of handlers.get(name) ?? []) handler(event);
    },
  };
}

describe("telegram chat allowlist", () => {
  let extension: Extension | undefined;

  afterEach(async () => {
    await extension?.shutdown?.();
    extension = undefined;
  });

  /** Starts the extension with a fake bot and the given settings. */
  async function start(config: Record<string, unknown>) {
    const fake = createFakeBot();
    const context = createFakeContext(config);
    extension = createExtension({ createBot: () => fake.bot });
    await extension.initialize(context.ctx);
    return { ...fake, ...context };
  }

  test("ignores every chat when neither allowedChatIds nor a default chat is set", async () => {
    const t = await start({});
    await t.receive(111, "hello");
    expect(t.enqueued).toEqual([]);
    expect(t.sent).toEqual([]);
  });

  test("accepts listed chats and the default chat, and ignores the rest", async () => {
    const t = await start({ ALLOWED_CHAT_IDS: ["111"], CHAT_ID: "222" });
    await t.receive(111, "from the list");
    await t.receive(222, "from the default chat");
    await t.receive(333, "from a stranger");
    expect(t.enqueued).toEqual(["telegram:111", "telegram:222"]);
  });

  test("logs a rejected chat once, with its ID", async () => {
    const t = await start({});
    await t.receive(333, "one");
    await t.receive(333, "two");
    expect(t.warnings).toHaveLength(1);
    expect(t.warnings[0]).toContain("333");
  });

  test("applies a changed allowlist from the settings", async () => {
    const t = await start({});
    t.emit("settings:changed", { extensionName: "telegram", values: { allowedChatIds: ["333"] } });
    await t.receive(333, "now allowed");
    expect(t.enqueued).toEqual(["telegram:333"]);
  });

  test("the agent tool cannot send to a chat outside the allowlist", async () => {
    const t = await start({ ALLOWED_CHAT_IDS: ["111"], CHAT_ID: "222" });
    const send = t.tool("send_telegram_message");

    const refused = await send.execute("call-1", { message: "hi", chat_id: "999" });
    expect(refused.content[0]!.text).toContain("not in the Telegram extension's allowed chats");
    expect(t.sent).toEqual([]);

    await send.execute("call-2", { message: "listed", chat_id: "111" });
    await send.execute("call-3", { message: "default" });
    expect(t.sent.map((m) => m.chat_id)).toEqual([111, 222]);
  });
});
