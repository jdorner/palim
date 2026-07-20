/**
 * Telegram extension - Telegram bot integration with message queuing
 * and persistent conversation history.
 *
 * State is encapsulated in a factory function so each call to
 * {@link createExtension} produces an isolated instance, making the
 * extension easier to test and reason about.
 */

import type { Extension, ExtensionContext, ExtensionManifest, Logger } from "@ext/types";
import { Type } from "@sinclair/typebox";
import TelegramBot from "node-telegram-bot-api";

const CHAT_ACTION_DELAY_MS = 3000;
const TELEGRAM_BOT_TOKEN = "TELEGRAM_BOT_TOKEN" as const;

const manifest = {
  name: "telegram",
  version: "1.0.0",
  description: "Telegram bot integration with message queuing and persistent conversation history",
  dependencies: [],
  settingsSchema: Type.Object({
    chatId: Type.Optional(
      Type.String({
        title: "Default Telegram chat ID",
        description: "Default Telegram chat ID for outgoing messages",
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
export function createExtension(): Extension {
  let logger: Logger;
  let bot: TelegramBot | null = null;
  let defaultChatId: string | undefined;

  // Per-chat typing indicator intervals
  const typingIntervals = new Map<number, ReturnType<typeof setInterval>>();

  function startTyping(chatId: number): void {
    if (typingIntervals.has(chatId)) return; // already running for this chat

    bot?.sendChatAction(chatId, "typing");
    typingIntervals.set(
      chatId,
      setInterval(() => bot?.sendChatAction(chatId, "typing"), CHAT_ACTION_DELAY_MS),
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

      const botToken = await ctx.secrets.get(TELEGRAM_BOT_TOKEN);
      if (!botToken || typeof botToken !== "string") {
        throw new Error(`${TELEGRAM_BOT_TOKEN} is required but not set.`);
      }

      const chatIdCfg = ctx.getConfig("CHAT_ID");
      defaultChatId =
        typeof chatIdCfg === "string" ? chatIdCfg : chatIdCfg !== undefined ? String(chatIdCfg) : undefined;

      bot = new TelegramBot(botToken, { polling: true });

      bot.on("polling_error", (err) => {
        logger.error("Telegram polling error:", err);
      });

      // Enqueue incoming messages with a server-side session.
      // The user message is appended to the session before enqueuing so the
      // agent processor sees it when loading session history.
      bot.on("message", async (msg) => {
        if (!msg.text) return;

        try {
          const chatId = msg.chat.id;
          const session = ctx.sessions.getOrCreate({
            source: this.manifest.name,
            sourceId: chatId.toString(),
          });

          // Persist the user message so the agent processor sees it in session history
          session.append({
            role: "user",
            content: msg.text,
            timestamp: Date.now(),
          });

          const jobId = await ctx.enqueueAgent(`telegram:${chatId}`, {
            context: { source: this.manifest.name, id: chatId.toString() },
            sessionId: session.id,
          });

          startTyping(chatId);

          logger.info(`Queued job ${jobId} for chat ${chatId} (session: ${session.id})`);
        } catch (err) {
          logger.error(`Failed to queue message from chat ${msg.chat.id}:`, err);
        }
      });

      // Route agent responses back to the originating Telegram chat.
      // Uses agent_end (not message_end) to avoid re-sending historical
      // assistant messages that were loaded from the session.
      ctx.on("agent_end", async (event) => {
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
          await bot!.sendMessage(chatId, finalText);
          logger.info(`Sent response to chat ${chatId}`);
        } catch (err) {
          logger.error(`Failed to send response to chat ${chatId}:`, err);
        }
      });

      // Register the send_telegram_message tool for proactive messaging
      const SendTelegramMessageParams = Type.Object({
        message: Type.String({ minLength: 1, description: "The message text to send" }),
        chat_id: Type.Optional(Type.String({ description: "Target Telegram chat ID. Uses default if omitted." })),
      });

      ctx.registerTool({
        name: "send_telegram_message",
        label: "Send Telegram Message",
        description: "Send a message to a Telegram chat",
        parameters: SendTelegramMessageParams,
        execute: async (_toolCallId, paramsRaw: unknown) => {
          const params = paramsRaw as { message: string; chat_id?: string };
          const targetChatId = params.chat_id || defaultChatId;

          if (!targetChatId) {
            return {
              content: [{ type: "text" as const, text: "Error: No chat_id provided and no default chat configured." }],
              details: {},
            };
          }

          try {
            await bot!.sendMessage(Number(targetChatId), params.message);

            // Persist the sent message in the session so the agent has context
            // when the user replies later.
            const session = ctx.sessions.getOrCreate({
              source: "telegram",
              sourceId: targetChatId,
            });
            session.append({
              role: "assistant",
              content: [{ type: "text", text: params.message }],
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

            return {
              content: [{ type: "text" as const, text: `Message sent to chat ${targetChatId}.` }],
              details: {},
            };
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text" as const, text: `Error sending message to chat ${targetChatId}: ${errorMsg}` }],
              details: {},
            };
          }
        },
      });

      // Re-assign default chat ID when extension settings change
      ctx.on("settings:changed", (event) => {
        if (!("extensionName" in event) || event.extensionName !== "telegram") return;

        const values = (event as { values?: Record<string, unknown> }).values;
        const raw = values?.chatId;
        const newChatId = raw != null ? String(raw) : undefined;

        if (defaultChatId === newChatId) return;
        defaultChatId = newChatId;
        logger.info(`Default chat ID updated${defaultChatId ? ` (****${defaultChatId.slice(-4)})` : " (cleared)"}`);
      });

      // Reconnect the bot when the bot token secret is updated
      ctx.on("secrets:changed", async (event) => {
        if (!("extensionName" in event) || event.extensionName !== "telegram") return;

        const { updatedKeys, deletedKeys } = event as { updatedKeys: string[]; deletedKeys: string[] };

        // Only react if the bot token was changed
        if (!updatedKeys.includes(TELEGRAM_BOT_TOKEN) && !deletedKeys.includes(TELEGRAM_BOT_TOKEN)) return;

        if (deletedKeys.includes(TELEGRAM_BOT_TOKEN)) {
          logger.info("Bot token deleted, stopping Telegram bot");
          if (bot) {
            try {
              await bot.stopPolling({ cancel: true });
              await bot.close();
            } catch (err) {
              logger.error("Error stopping Telegram bot after token deletion:", err);
            }
            bot = null;
          }
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
            await bot.stopPolling({ cancel: true });
            await bot.close();
          } catch (err) {
            logger.error("Error stopping old Telegram bot instance:", err);
          }
        }

        bot = new TelegramBot(newToken, { polling: true });
        bot.on("polling_error", (err) => {
          logger.error("Telegram polling error:", err);
        });

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

          await bot.stopPolling({ cancel: true });
          bot.close();
        } catch (err) {
          logger.error("Error stopping Telegram bot:", err);
        }
        bot = null;
      }
    },
  };
}

export default createExtension();
