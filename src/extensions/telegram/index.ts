/**
 * Telegram extension - Telegram bot integration with message queuing
 * and persistent conversation history.
 *
 * State is encapsulated in a factory function so each call to
 * {@link createExtension} produces an isolated instance, making the
 * extension easier to test and reason about.
 */

import type { Extension, ExtensionContext, ExtensionManifest, Logger } from "@ext/types";
import type { ImageContent } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { Bot, type Message } from "node-telegram-bot-api";
import { DEFAULT_MESSAGE_FORMAT, deliverMessage, type MessageFormat, parseMessageFormat } from "./delivery";
import {
  buildUserContent,
  downloadImage,
  getImageRefs,
  ImageTooLargeError,
  MAX_IMAGE_SIZE_MB,
  parseMaxImageSizeMb,
  type TelegramImageRef,
} from "./images";
import { createNotifyStepHandler } from "./notifyStep";

const CHAT_ACTION_DELAY_MS = 3000;
/** Telegram delivers album items as separate updates; wait this long for the rest of the group. */
const MEDIA_GROUP_DEBOUNCE_MS = 1000;
const TELEGRAM_BOT_TOKEN = "TELEGRAM_BOT_TOKEN" as const;

const manifest = {
  name: "telegram",
  version: "1.3.0",
  description: "Telegram bot integration with message queuing and persistent conversation history",
  dependencies: ["workflows"],
  settingsSchema: Type.Object({
    chatId: Type.Optional(
      Type.String({
        title: "Default Telegram chat ID",
        description: "Default Telegram chat ID for outgoing messages",
      }),
    ),
    maxImageSizeMb: Type.Optional(
      Type.Number({
        title: "Max image size (MB)",
        description: `Incoming images larger than this are rejected. Telegram's Bot API caps downloads at ${MAX_IMAGE_SIZE_MB} MB.`,
        default: MAX_IMAGE_SIZE_MB,
        minimum: 1,
        maximum: MAX_IMAGE_SIZE_MB,
      }),
    ),
    format: Type.Optional(
      Type.Union([Type.Literal("markdown"), Type.Literal("plain")], {
        title: "Message format",
        description:
          "How outgoing messages are rendered. 'markdown' sends rich messages (GitHub Flavored Markdown) and falls back to plain text if Telegram rejects them.",
        default: DEFAULT_MESSAGE_FORMAT,
      }),
    ),
  }),
  secretsSchema: [{ key: TELEGRAM_BOT_TOKEN, description: "Telegram bot token from @BotFather", required: true }],
} satisfies ExtensionManifest;

/**
 * Creates a fresh Telegram extension instance with its own encapsulated state.
 *
 * @returns An {@link Extension} object ready to be loaded by the registry
 */
/** Album items collected until the media group's debounce timer fires. */
interface PendingMediaGroup {
  chatId: number;
  texts: string[];
  refs: TelegramImageRef[];
  timer: ReturnType<typeof setTimeout>;
}

export function createExtension(): Extension {
  let logger: Logger;
  let bot: Bot | null = null;
  let botToken: string | null = null;
  let defaultChatId: string | undefined;
  let maxImageSizeMb = MAX_IMAGE_SIZE_MB;
  let messageFormat: MessageFormat = DEFAULT_MESSAGE_FORMAT;

  // Album items buffered per media_group_id
  const mediaGroups = new Map<string, PendingMediaGroup>();

  // Per-chat typing indicator intervals
  const typingIntervals = new Map<number, ReturnType<typeof setInterval>>();

  function startTyping(chatId: number): void {
    if (typingIntervals.has(chatId)) return; // already running for this chat

    bot?.api.sendChatAction({ chat_id: chatId, action: "typing" });
    typingIntervals.set(
      chatId,
      setInterval(() => bot?.api.sendChatAction({ chat_id: chatId, action: "typing" }), CHAT_ACTION_DELAY_MS),
    );
  }

  function stopTyping(chatId: number): void {
    const interval = typingIntervals.get(chatId);
    if (interval) {
      clearInterval(interval);
      typingIntervals.delete(chatId);
    }
  }

  return {
    manifest,

    async initialize(ctx: ExtensionContext) {
      logger = ctx.log;

      const token = await ctx.secrets.get(TELEGRAM_BOT_TOKEN);
      if (!token || typeof token !== "string") {
        throw new Error(`${TELEGRAM_BOT_TOKEN} is required but not set.`);
      }

      const chatIdCfg = ctx.config.get("CHAT_ID");
      defaultChatId =
        typeof chatIdCfg === "string" ? chatIdCfg : chatIdCfg !== undefined ? String(chatIdCfg) : undefined;
      maxImageSizeMb = parseMaxImageSizeMb(ctx.config.get("MAX_IMAGE_SIZE_MB"));
      messageFormat = parseMessageFormat(ctx.config.get("FORMAT"));

      /**
       * Appends the user message to the chat's session and enqueues an agent
       * job. Messages with images run on the vision-intent model.
       */
      async function submitUserMessage(chatId: number, text: string, images: ImageContent[]): Promise<void> {
        const session = ctx.sessions.getOrCreate({
          source: manifest.name,
          sourceId: chatId.toString(),
        });

        // Persist the user message so the agent processor sees it in session history
        session.append({
          role: "user",
          content: buildUserContent(text, images),
          timestamp: Date.now(),
        });

        const jobId = await ctx.agent.enqueue(`telegram:${chatId}`, {
          context: { source: manifest.name, id: chatId.toString() },
          sessionId: session.id,
          ...(images.length > 0 ? { intent: "vision" as const } : {}),
        });

        startTyping(chatId);

        logger.info(
          `Queued job ${jobId} for chat ${chatId} (session: ${session.id}${images.length > 0 ? `, ${images.length} image(s)` : ""})`,
        );
      }

      /**
       * Downloads any images, then submits the message. Download failures are
       * reported to the chat and the message is not enqueued.
       */
      async function handleIncoming(chatId: number, text: string, refs: TelegramImageRef[]): Promise<void> {
        const images: ImageContent[] = [];
        if (refs.length > 0) {
          const currentBot = bot;
          if (!currentBot || !botToken) return;

          startTyping(chatId);
          try {
            for (const ref of refs) {
              images.push(await downloadImage(currentBot, botToken, ref, maxImageSizeMb));
            }
          } catch (err) {
            stopTyping(chatId);
            const tooLarge = err instanceof ImageTooLargeError;
            logger.error(`Failed to download image from chat ${chatId}:`, err instanceof Error ? err.message : err);
            await currentBot.api
              .sendMessage({ chat_id: chatId, text: tooLarge ? err.message : "Could not download image." })
              .catch((sendErr) => logger.error(`Failed to send image error to chat ${chatId}:`, sendErr));
            return;
          }
        }

        await submitUserMessage(chatId, text, images);
      }

      /** Buffers an album item; the group is submitted once no new item arrived for the debounce period. */
      function bufferMediaGroup(groupId: string, chatId: number, text: string, refs: TelegramImageRef[]): void {
        const pending = mediaGroups.get(groupId);
        if (pending) clearTimeout(pending.timer);

        const group: PendingMediaGroup = {
          chatId,
          texts: [...(pending?.texts ?? []), ...(text ? [text] : [])],
          refs: [...(pending?.refs ?? []), ...refs],
          timer: setTimeout(() => {
            mediaGroups.delete(groupId);
            handleIncoming(group.chatId, group.texts.join("\n\n"), group.refs).catch((err) => {
              stopTyping(group.chatId);
              logger.error(`Failed to queue album from chat ${group.chatId}:`, err);
            });
          }, MEDIA_GROUP_DEBOUNCE_MS),
        };
        mediaGroups.set(groupId, group);
      }

      /** Handles one incoming message: text, caption, photo, or image document. */
      async function onMessage(msg: Message | undefined): Promise<void> {
        if (!msg) return;

        const chatId = msg.chat.id;
        const text = msg.text ?? msg.caption ?? "";
        const refs = getImageRefs(msg);
        if (!text && refs.length === 0) return;

        try {
          if (msg.media_group_id && refs.length > 0) {
            bufferMediaGroup(msg.media_group_id, chatId, text, refs);
            return;
          }
          await handleIncoming(chatId, text, refs);
        } catch (err) {
          stopTyping(chatId);
          logger.error(`Failed to queue message from chat ${chatId}:`, err);
        }
      }

      /** Creates a bot, wires the error boundary and message handler, and starts polling. */
      function connectBot(token: string): void {
        botToken = token;
        bot = new Bot(token);

        // v2 routes all handler/polling errors to the error boundary instead of a
        // `polling_error` event. The default boundary logs and continues; we keep
        // that continue-on-error behavior but log through our own logger.
        bot.catch((err) => {
          logger.error("Telegram bot error:", err);
        });

        // Enqueue incoming messages with a server-side session.
        // The user message is appended to the session before enqueuing so the
        // agent processor sees it when loading session history.
        bot.on("message", (msgCtx) => onMessage(msgCtx.message));

        // Start the long-poll pump. This returns a promise that resolves when the
        // bot is stopped; it must not be awaited here or it would block init.
        // Handler/polling errors are routed to the `catch` boundary above, so this
        // promise only rejects if that boundary itself throws.
        void bot.startPolling();
      }

      connectBot(token);

      // Route agent responses back to the originating Telegram chat.
      // Uses agent_end (not message_end) to avoid re-sending historical
      // assistant messages that were loaded from the session.
      ctx.events.on("agent_end", async (event) => {
        if (event.type !== "agent_end") return;

        const chatId = Number(event.context?.id);

        // Ignore events not originating from a telegram chat
        if (!chatId || event.context?.source !== this.manifest.name) return;

        // Extract assistant messages
        const newAssistantMsgs = (event.messages ?? []).filter(
          (msg) => msg.role === "assistant" && Array.isArray(msg.content),
        );

        const lastMsg = newAssistantMsgs.at(-1);
        if (lastMsg?.role !== "assistant") return;

        // Skip sending if the last assistant message was aborted
        if (lastMsg.stopReason !== "stop") {
          logger.info(`Agent job for chat ${chatId} was cancelled; not sending partial response`);
          stopTyping(chatId);
          return;
        }

        // Stop typing indicator before sending the final response
        stopTyping(chatId);

        const finalText = (lastMsg.content as Array<{ type: string; text?: string }>)
          .filter((block) => block.type === "text")
          .map((block) => block.text ?? "")
          .join("");
        if (!finalText) return;

        try {
          await deliverMessage(bot!, chatId, finalText, messageFormat, logger);
          logger.info(`Sent response to chat ${chatId}`);
        } catch (err) {
          logger.error(`Failed to send response to chat ${chatId}:`, err);
        }
      });

      /**
       * Sends a message to a Telegram chat and persists it in the session so
       * the agent has context when the user replies later.
       *
       * Shared by the `send_telegram_message` tool and the `notify` workflow
       * step type so both go through the same delivery and persistence path.
       *
       * @param message - The message text to send
       * @param chatId - Target chat ID; falls back to the configured default when omitted
       * @param format - Message format; falls back to the configured format when omitted
       * @returns The chat ID the message was delivered to
       * @throws If no chat ID is available, the bot is not connected, or the send fails
       */
      async function sendTelegramMessage(message: string, chatId?: string, format?: MessageFormat): Promise<string> {
        const targetChatId = chatId || defaultChatId;

        if (!targetChatId) {
          throw new Error("No chat_id provided and no default chat configured.");
        }
        if (!bot) {
          throw new Error("Telegram bot is not connected (missing or invalid bot token).");
        }

        await deliverMessage(bot, Number(targetChatId), message, format ?? messageFormat, logger);

        // Persist the sent message in the session so the agent has context
        // when the user replies later.
        const session = ctx.sessions.getOrCreate({
          source: "telegram",
          sourceId: targetChatId,
        });
        session.append({
          role: "assistant",
          content: [{ type: "text", text: message }],
          api: "synthetic",
          provider: "telegram",
          model: "send_telegram_message",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        });

        return targetChatId;
      }

      // Register the send_telegram_message tool for proactive messaging
      const SendTelegramMessageParams = Type.Object({
        message: Type.String({
          minLength: 1,
          description: "The message text to send. Supports GitHub Flavored Markdown.",
        }),
        chat_id: Type.Optional(Type.String({ description: "Target Telegram chat ID. Uses default if omitted." })),
      });

      ctx.tools.register({
        name: "send_telegram_message",
        label: "Send Telegram Message",
        description: "Send a message to a Telegram chat",
        parameters: SendTelegramMessageParams,
        execute: async (_toolCallId, paramsRaw: unknown) => {
          const params = paramsRaw as { message: string; chat_id?: string };
          try {
            const deliveredTo = await sendTelegramMessage(params.message, params.chat_id);
            return {
              content: [{ type: "text" as const, text: `Message sent to chat ${deliveredTo}.` }],
              details: {},
            };
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text" as const, text: `Error sending message: ${errorMsg}` }],
              details: {},
            };
          }
        },
      });

      // Register the `notify` workflow step type: a deterministic Telegram send
      // that reuses the same delivery path as the tool. The bot token stays
      // encapsulated (never templated into workflow files).
      ctx.stepTypes.register("notify-telegram", createNotifyStepHandler(sendTelegramMessage));

      // Re-assign default chat ID when extension settings change
      ctx.events.on("settings:changed", (event) => {
        if (!("extensionName" in event) || event.extensionName !== "telegram") return;

        const values = (event as { values?: Record<string, unknown> }).values;
        maxImageSizeMb = parseMaxImageSizeMb(values?.maxImageSizeMb);
        messageFormat = parseMessageFormat(values?.format);

        const raw = values?.chatId;
        const newChatId = raw != null ? String(raw) : undefined;

        if (defaultChatId === newChatId) return;
        defaultChatId = newChatId;
        logger.info(`Default chat ID updated${defaultChatId ? ` (****${defaultChatId.slice(-4)})` : " (cleared)"}`);
      });

      // Reconnect the bot when the bot token secret is updated
      ctx.events.on("secrets:changed", async (event) => {
        if (!("extensionName" in event) || event.extensionName !== "telegram") return;

        const { updatedKeys, deletedKeys } = event as { updatedKeys: string[]; deletedKeys: string[] };

        // Only react if the bot token was changed
        if (!updatedKeys.includes(TELEGRAM_BOT_TOKEN) && !deletedKeys.includes(TELEGRAM_BOT_TOKEN)) return;

        if (deletedKeys.includes(TELEGRAM_BOT_TOKEN)) {
          logger.info("Bot token deleted, stopping Telegram bot");
          if (bot) {
            try {
              bot.stop();
            } catch (err) {
              logger.error("Error stopping Telegram bot after token deletion:", err);
            }
            bot = null;
          }
          botToken = null;
          return;
        }

        // Token was updated - reconnect with new credentials
        const newToken = await ctx.secrets.get(TELEGRAM_BOT_TOKEN);
        if (!newToken || typeof newToken !== "string") {
          logger.error(`secrets:changed fired but ${TELEGRAM_BOT_TOKEN} could not be read`);
          return;
        }

        logger.info("Bot token updated, reconnecting Telegram bot");
        if (bot) {
          try {
            bot.stop();
          } catch (err) {
            logger.error("Error stopping old Telegram bot instance:", err);
          }
        }

        connectBot(newToken);

        logger.info("Telegram bot reconnected with new token");
      });

      logger.info(`Telegram bot initialized${defaultChatId ? ` (default chat: ****${defaultChatId.slice(-4)})` : ""}`);
    },

    async shutdown() {
      if (bot) {
        try {
          // Clear all timers
          typingIntervals.forEach((interval, chatId) => {
            clearInterval(interval);
            typingIntervals.delete(chatId);
          });
          for (const group of mediaGroups.values()) clearTimeout(group.timer);
          mediaGroups.clear();

          bot.stop();
        } catch (err) {
          logger.error("Error stopping Telegram bot:", err);
        }
        bot = null;
      }
    },
  };
}

export default createExtension();
