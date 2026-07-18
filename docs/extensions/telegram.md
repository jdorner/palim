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

## Settings

All settings are configurable in the web UI under **Settings > Extensions > Telegram**.

### Default Telegram Chat ID

The default chat ID used by the `send_telegram_message` tool when no explicit `chat_id` is provided. Useful for proactive notifications (e.g. from scheduled tasks).

Default: none (must be provided per-call if not configured)

## Environment Variable Override

| Setting | Environment Variable |
| --- | --- |
| Default Chat ID | `EXT_TELEGRAM_CHAT_ID` |

## Agent Tool

The extension registers a `send_telegram_message` tool that the agent can use to proactively send messages:

**Parameters:**

- `message` (required) - The text to send
- `chat_id` (optional) - Target chat ID. Falls back to the configured default.

## Session Persistence

Each Telegram chat gets its own session. The agent sees the full conversation history when responding, providing multi-turn context. Sessions persist across restarts.

## Reconnection

When the bot token secret is updated via the UI, the bot automatically disconnects and reconnects with the new token. Deleting the token stops the bot entirely.
