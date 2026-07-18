# Palim - Your Personal AI Agent

![Palim](./media/palim_logo.png)

> "*All they need is ~~tools~~ shell commands!*"

**An AI agent that lives on your machine, works with your data, and automates the things you don't want to do manually.**

Palim connects to a local or remote LLM and turns it into a capable personal assistant. Instead of implementing custom tool functions for every capability, Palim gives the agent a shell. Extensions and skills expose their functionality as shell commands, keeping the interface uniform and composable. The agent schedules tasks, processes documents, manages information, and integrates with your existing services - all through shell commands executed in a sandboxed workspace.

## What Palim Does

**Automate repetitive work.** Set up scheduled tasks, file watchers, and multi-step workflows. Palim handles them in the background and reports back when something needs your attention.

**Process documents.** Set up a file watcher and workflow to convert PDFs or images to structured markdown using a vision model. Combine it with scheduling or webhooks to build automated document pipelines.

**Chat naturally.** Ask questions, give instructions, or have a conversation. Palim maintains full conversation history within a session, so you can pick up where you left off. It can pull in information from your wiki, the web, or connected services.

**Integrate your services.** Webhooks let external services trigger the agent. Telegram integration gives you a mobile interface. MCP bridging connects to any MCP server. And if something isn't covered, you can write your own extension.

**Keep your data private.** Palim runs entirely on your hardware. Point it at a local LLM (llama.cpp, llama-swap, or similar) and nothing leaves your network. Or connect to any OpenAI-compatible API if you prefer cloud models.

## How It Works

You give Palim a working directory - a folder on your machine where it can read, write, and organize files. This is its workspace. Inside, it manages e.g. a task list, a wiki, workflow definitions, or inbox/outbox folders for document processing.

The agent operates inside a sandboxed shell. It has full access to your designated workspace but cannot touch anything else on your system. Extensions handle external integrations (APIs, messaging, web access) on behalf of the agent, keeping secrets and credentials separate.

Everything runs through a job queue system. Whether it's a chat message, a scheduled task, or a webhook trigger, work is queued, processed, and logged. You can monitor it all in real time through the web UI.

## Built-in Capabilities

| Feature | What it does |
|---------|--------------|
| Conversations | Multi-turn chat with streamed responses and persistent history |
| Scheduling | Cron jobs and interval-based tasks that survive restarts |
| Workflows | Multi-step pipelines that chain agent actions together |
| Document processing | PDF/image to markdown conversion via vision LLM |
| File watching | Automatically react when files appear in monitored folders |
| Webhooks | Receive events from external services (GitHub, CI, monitoring, etc.) |
| Wiki | A knowledge base the agent can read and write |
| Telegram | Chat with the agent from your phone |
| MCP bridging | Connect any Model Context Protocol server |
| Web access | Let the agent fetch and read web pages |

## Who Is This For?

Palim is for people who want a personal AI assistant that:

- Runs locally, under their control
- Automates information management and system integration tasks
- Works in the background without constant supervision
- Is extensible without requiring deep framework knowledge

It is **not** intended to be another software development agent. While it can technically write code, its focus is on the operational side: managing files, scheduling tasks, processing documents, and connecting systems.

## Getting Started

Clone the repo and run the setup:

```bash
git clone https://github.com/jdorner/palim.git

cd palim
bun install        # Install dependencies
bun run setup      # Interactive configuration (LLM endpoint, API key, frontend build)
bun run start      # Start Palim
```

Open `http://localhost:3000` and start chatting. The setup wizard handles everything else.

After first start, check Settings > Extensions in the web UI to enable the capabilities you want (optional extensions are disabled by default).

**Requirements:** [Bun](https://bun.sh/) (the JavaScript runtime) and an LLM endpoint. That's it!

## Runs Anywhere

- **Direct** - Run natively on Linux, macOS, or WSL
- **Docker / Podman** - Pre-built Dockerfile included
- **Any LLM backend** - llama.cpp, llama-swap, vLLM, OpenAI, Together AI, OpenRouter, or any OpenAI-compatible API

## Open Source

Palim is [MIT licensed](../LICENSE). Use it, modify it, extend it. Contributions welcome.
