/**
 * Chat allowlist for the Telegram bot.
 *
 * Anyone who knows a bot's username can message it, and every accepted message
 * starts an agent with write access to the work directory, web access and
 * skills. The bot therefore only talks to chats it was told about: the
 * `allowedChatIds` setting plus the default chat for outgoing messages. With
 * neither set, it talks to no one.
 *
 * A private chat's ID is the user's ID. Allowing a group allows all its members.
 *
 * @module
 */

/**
 * Normalizes the `allowedChatIds` setting into a list of chat IDs.
 *
 * Accepts the string array the settings UI stores, and a number or a
 * comma-separated string from an `EXT_TELEGRAM_ALLOWED_CHAT_IDS` env value.
 * Blank entries are dropped.
 *
 * @param raw - The raw setting value
 * @returns The chat IDs as trimmed strings, without duplicates
 */
export function parseChatIdList(raw: unknown): string[] {
  const entries: unknown[] = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [raw];
  const ids = entries
    .filter((entry) => typeof entry === "string" || (typeof entry === "number" && Number.isFinite(entry)))
    .map((entry) => String(entry).trim())
    .filter((id) => id !== "");
  return [...new Set(ids)];
}

/**
 * Decides whether the bot may talk to a chat.
 *
 * @param chatId - The chat to check
 * @param allowedChatIds - The `allowedChatIds` setting, normalized
 * @param defaultChatId - The default chat for outgoing messages, which is always allowed
 * @returns Whether the chat is allowed
 */
export function isChatAllowed(
  chatId: number | string,
  allowedChatIds: readonly string[],
  defaultChatId: string | undefined,
): boolean {
  const id = String(chatId).trim();
  if (id === "") return false;
  return allowedChatIds.includes(id) || (defaultChatId !== undefined && defaultChatId.trim() === id);
}
