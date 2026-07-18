# Steering

The Steering extension injects additional text into the system prompt before each agent run. Use it to set the agent's persona, enforce behavioral constraints, or add persistent instructions.

## Enabling

Enable the extension in the web UI under **Settings > Extensions** by toggling the switch next to "steering".

## How It Works

Every time an agent run starts (chat, scheduled task, telegram message, workflow step), the configured prompt text is appended to the system prompt. This applies globally to all agent interactions.

## Settings

All settings are configurable in the web UI under **Settings > Extensions > Steering**.

### Additional Prompt

The text that is injected at the end of the system prompt. Supports multi-line content.

Default: `Your name is Palim, a helpful AI agent.`

Change this to define the agent's personality, add rules, or inject context that should always be present.

## Environment Variable Override

| Setting | Environment Variable |
| --- | --- |
| Additional Prompt | `EXT_STEERING_PROMPT` |

## Tips

- Keep the prompt concise. It's appended to every agent run and consumes context tokens.
- Use it for identity ("You are..."), behavioral rules ("Never do X"), or persistent context ("The user prefers...").
- Changes take effect on the next agent run without restart.
