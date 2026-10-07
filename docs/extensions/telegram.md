# Telegram

The Telegram extension integrates a Telegram bot that receives messages, queues them as agent jobs, and sends back responses. Conversations are persisted per-chat so the agent retains multi-turn context.

## Enabling

Enable the extension in the web UI under **Settings > Extensions** by toggling the switch next to "telegram".

## Prerequisites

A Telegram bot token is required. Create one via [@BotFather](https://t.me/BotFather) and store it in the extension's secrets (Settings > Extensions > Telegram > Secrets).

| Secret | Description |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Bot token from BotFather (required) |

The extension will not start without this secret set.

## How It Works

1. The bot polls Telegram for incoming messages
2. Each message is appended to a per-chat session (persistent conversation history)
3. A job is enqueued on the agents queue
4. When the agent finishes, the response is sent back to the originating chat
5. A typing indicator is shown while the agent is processing

## Images

Photos and images sent as files (uncompressed) are downloaded and passed to the LLM together with the message caption.

- Messages with images run on the model selected for the **vision** intent (Settings > Models). If no vision-capable model is available, the default model is used and the image is replaced with a placeholder.
- Albums (several photos sent at once) are combined into a single message and a single agent job.
- Images larger than the **Max image size** setting are rejected, and the bot replies with an error instead of queuing a job.
- Images are stored in the chat session, so they stay part of the conversation context for later turns.

## Settings

All settings are configurable in the web UI under **Settings > Extensions > Telegram**.

### Default Telegram Chat ID

The default chat ID used by the `send_telegram_message` tool when no explicit `chat_id` is provided. Useful for proactive notifications (e.g. from scheduled tasks).

Default: none (must be provided per-call if not configured)

### Max Image Size (MB)

Incoming images larger than this are rejected. Telegram's Bot API does not allow bots to download files above 20 MB, so values above 20 are capped.

Default: `20`

## Environment Variable Override

| Setting | Environment Variable |
| --- | --- |
| Default Chat ID | `EXT_TELEGRAM_CHAT_ID` |
| Max Image Size (MB) | `EXT_TELEGRAM_MAX_IMAGE_SIZE_MB` |

## Agent Tool

The extension registers a `send_telegram_message` tool that the agent can use to proactively send messages:

**Parameters:**

- `message` (required) - The text to send
- `chat_id` (optional) - Target chat ID. Falls back to the configured default.

## Session Persistence

Each Telegram chat gets its own session. The agent sees the full conversation history when responding, providing multi-turn context. Sessions persist across restarts.

## Reconnection

When the bot token secret is updated via the UI, the bot automatically disconnects and reconnects with the new token. Deleting the token stops the bot entirely.
