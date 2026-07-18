# AGENTS.md

## Overview

An AI agent platform called **Palim**, built on [pi-agent-core](https://github.com/earendil-works/pi/tree/main/packages/agent) and **Bun**. It combines a conversational AI agent with a job queue system, a plugin-style extension architecture, a Svelte 5 web UI, and local LLM inference via llama.cpp (direct or through llama-swap proxy).

The agent operates inside a sandboxed shell powered by just-bash. The configured `AGENT_WORK_DIR` is mounted into a virtual filesystem, giving the agent full read/write access to that directory while isolating it from the rest of the host. Skills are also mounted into the sandbox. The agent uses markdown-based skills and tasks for context and instructions.

## Quick Start

```bash
# Install dependencies
bun install

# Interactive first-time setup (creates .env, prompts for LLM config, builds frontend)
bun run setup

# Or manually:
cp .env.example .env
# Edit .env with your values
cd frontend && bun install && bun run build && cd ..

# Start the agent
bun run start
```

The web UI is served at `http://localhost:3000` by default (configurable via `WEB_SCHEME`, `WEB_HOST`, and `WEB_PORT`).

## Runtime & Tooling

- **Runtime:** Bun 1.3.14+
- **Language:** TypeScript 7.0.2+ (ESNext, bundler module resolution, strict mode)
- **LLM:** llama.cpp on `localhost:11434` (OpenAI-compatible API, supports llama-swap proxy). Dynamic model discovery in `src/models.ts`.
- **Linter/Formatter:** Biome (`bun run check`). Config in `biome.json`.
- **Frontend:** Svelte 5 + Vite 8 + Tailwind CSS 4. Built to `frontend/dist/`, served as static files by Elysia.
- **Database:** Drizzle ORM + Bun's native SQLite (WAL mode). Migrations in `drizzle/`.

## Environment Variables

| Variable               | Purpose                                        | Default                    |
| ---------------------- | ---------------------------------------------- | -------------------------- |
| `OPENAI_API_KEY`       | LLM provider API key                           | -                          |
| `OPENAI_API_BASE_URL`  | LLM endpoint base URL                          | `http://localhost:11434/v1`|
| `OPENAI_DEFAULT_MODEL` | LLM default model                              | -                          |
| `AGENT_WORK_DIR`       | Agent working directory (mounted into sandbox) | `.work/`                   |
| `WEB_SCHEME`           | URL scheme (`http` or `https`)                 | `http`                     |
| `WEB_HOST`             | Web server bind address                        | `localhost`                |
| `WEB_PORT`             | Web server port                                | `3000`                     |
| `EXTENSIONS_DIR`       | Custom extensions directory                    | `src/extensions`           |
| `AUTH_TOKEN`           | Bearer token for API/WS auth (empty = disabled)| -                          |
| `DATA_DIR`             | Directory for databases and generated content  | `<AGENT_WORK_DIR>/.palim/` |
| `TELEGRAM_BOT_TOKEN`   | Telegram bot token                             | -                          |
| `EXT_TELEGRAM_CHAT_ID` | Default Telegram chat ID                       | -                          |

## Project Structure

```text
src/
├── main.ts                  # Entry point: constructs and starts AppBootstrap
├── sandboxCLI.ts            # Interactive sandbox shell (just-bash REPL)
├── config.ts                # Centralized env-based config
├── models.ts                # Dynamic LLM model discovery and provider strategy
├── app/
│   └── boot.ts              # AppBootstrap: orchestrates full startup sequence
├── db/
│   ├── index.ts             # Drizzle ORM connection, migrations, getDb()
│   ├── schema.ts            # Database schema definitions
│   └── appConfig.ts         # Key-value app configuration store
├── session/
│   ├── sessionStore.ts      # SQLite-backed conversation session persistence
│   ├── pushMessage.ts       # PushMessage type + pi-agent-core declaration merging
│   └── types.ts             # Session, SessionStorePort interfaces
├── jobs/
│   ├── agentProcessor.ts    # Reusable runAgent() function for queue processors
│   ├── agentQueue.ts        # General agent prompt queue factory
│   ├── chatQueue.ts         # Conversational chat queue factory
│   ├── cancellation.ts      # Job abort/cancellation utilities
│   ├── systemPrompts.ts     # System prompt builders for agent and chat
│   ├── defaults.ts          # Shared AGENT_QUEUE_DEFAULTS options
│   └── index.ts             # Re-exports
├── queue/
│   ├── managedQueue.ts      # ManagedQueue abstraction over bunqueue
│   ├── logStore.ts          # Persistent job log store (SQLite, periodic purge)
│   ├── types.ts             # Queue contract interfaces (ManagedQueuePort, etc.)
│   └── index.ts             # Re-exports
├── push/
│   ├── pushService.ts       # Programmatic push API (inject out-of-band messages into chat)
│   └── index.ts             # Re-exports
├── web/
│   ├── server.ts            # Elysia HTTP + WebSocket server factory
│   ├── compression.ts       # Elysia compression plugin (gzip, deflate, brotli with LRU cache)
│   ├── dynamicItemProviders.ts # Provider registry for dynamic settings schema enrichment
│   ├── monitor.ts           # Real-time job state push to WS clients
│   ├── auth.ts              # Bearer token auth middleware
│   ├── chatEvents.ts        # Agent event to chat WS event mappingg
│   ├── sessionChatMap.ts    # In-memory session-to-chat mapping for push routing
│   └── routes/
│       ├── auth.ts          # POST /api/auth/validate
│       ├── chat.ts          # POST /api/chat
│       ├── extensions.ts    # GET/PUT /api/extensions (settings with dynamic item enrichment)
│       ├── jobs.ts          # Job cancel, logs, queue clean endpoints
│       ├── models.ts        # GET/PUT /api/models (selection + listing)
│       ├── push.ts          # POST /api/push (out-of-band message injection)
│       ├── secrets.ts       # Extension secret CRUD + audit log
│       ├── globalSecrets.ts # Global secret CRUD + audit log
│       └── sessions.ts      # GET/DELETE /api/sessions/:id/messages
├── extensions/
│   ├── types.ts             # Public extension API (Extension, ExtensionContext)
│   ├── registry.ts          # Discovery, validation, dependency resolution, lifecycle
│   ├── extensionContext.ts  # Scoped context factory per extension
│   ├── eventBus.ts          # Agent lifecycle event dispatch
│   ├── dependencyResolver.ts # Topological sort for load order
│   ├── internalTypes.ts     # Internal registry types (not for extension authors)
│   ├── sdk.ts               # Extension SDK re-exports
│   ├── core/                # Core extensions (non-deactivatable infrastructure)
│   │   ├── filewatcher/     # Directory watchers emitting domain events
│   │   ├── scheduler/       # Cron/interval-based job scheduling
│   │   ├── webhooks/        # Authenticated HTTP endpoints for external events
│   │   └── workflows/       # Multi-step job pipelines (JSON5)
│   └── <name>/index.ts      # Optional extensions (see list below)
├── secrets/
│   ├── vault.ts             # SecretVault: SQLite-backed AES-256-GCM encrypted storage with per-row ACL
│   ├── vaultSchema.ts       # Drizzle schema for secrets_vault table
│   ├── acl.ts               # Pattern matching for consumer identity ACL checks
│   ├── audit.ts             # SQLite-backed secret access audit log
│   ├── types.ts             # SecretResolution, SecretAclEntry, SecretAuditRecord, SetSecretOptions
│   └── index.ts             # Re-exports
├── skills/
│   ├── skills.ts            # Skill directory loading and system prompt building
│   ├── frontmatter.ts       # YAML frontmatter parsing for skill markdown
│   └── index.ts             # Re-exports
├── tools/
│   ├── file.ts              # read_file, write_file, list_files, create_directory, edit
│   └── sandbox.ts           # just-bash sandbox setup (virtual FS, built-in programs)
└── utils/
    ├── command.ts           # Sandbox program builder (subcommands, arg parsing)
    ├── error.ts             # Error classification utilities (LLM connection errors)
    ├── fetch.ts             # Authenticated fetch wrapper (auto-injects auth for internal API calls)
    ├── logger.ts            # Structured loggers (mainLogger, shellLogger)
    ├── fileWatcher.ts       # Watcher that auto-queues jobs
    └── validation.ts        # Shared validation helpers

shared/
└── types.ts                 # Types shared between backend and frontend
                             # (JobEntry, LogEntry, WebSocketMessage, ChatWebSocketEvent,
                             #  WorkflowWebSocketEvent, FeedbackReportEvent, ApprovalRequestEvent,
                             #  ExtensionLifecycleEvent, PushMessageEvent, TokenUsage, SessionUsage,
                             #  ScheduleEntry, NavigationEntry, ExtensionUiContribution,
                             #  ExtensionInfo, AvailableModel, SelectedModelResponse)

frontend/                    # Svelte 5 web UI (page-based routing)
└── src/
    ├── App.svelte           # App shell with sidebar navigation
    ├── router.ts            # Client-side page router
    ├── routes/              # Page components
    │   ├── ChatPage.svelte
    │   ├── JobsPage.svelte
    │   ├── SchedulesPage.svelte
    │   ├── WorkflowsPage.svelte
    │   ├── WorkflowDetailPage.svelte
    │   ├── WorkflowRunPage.svelte
    │   ├── WebhooksPage.svelte
    │   ├── FileWatchersPage.svelte
    │   ├── McpServersPage.svelte
    │   ├── SettingsPage.svelte
    │   └── LoginPage.svelte
    ├── components/          # Feature components
    │   ├── ChatInput, ChatView, ContextGauge, ConversationList, MessageArea
    │   ├── JobList, JobLogs, JobFilters
    │   ├── ScheduleList, SettingsForm, WorkflowGraph, WorkflowStepNode, FitViewOnInit
    │   ├── WebhookList, FileWatcherList
    │   ├── ModelSelector, Sidebar
    │   └── ...
    └── lib/                 # Stores, auth, UI primitives
        ├── appStore.ts, auth.ts, chatStore.ts
        ├── badgeRegistry.ts, extensionStore.ts, iconRegistry.ts
        ├── chatStreamStore.svelte.ts, connectionStore.svelte.ts
        ├── modelStore.svelte.ts, readState.svelte.ts, settingsStore.svelte.ts
        ├── workflowRunStore.svelte.ts, workflowValidation.ts
        ├── utils.ts
        └── components/      # Reusable UI (shadcn-style primitives)

WORK_DIR/                       # AGENT_WORK_DIR - the agent's workspace (real directory mounted into sandbox)
├── inbox/                   # Drop files here for auto-processing (OCR)
├── outbox/                  # Processed file output
├── data/                    # Agent data files (wiki, error reports, etc.)
├── tasks.md                 # Task list ([ ] open, [x] done, [p] in progress)
└── workflows/               # Workflow pipeline definitions (YAML)
```

## Architecture

### Boot Sequence (`src/app/boot.ts`)

The `AppBootstrap` class separates construction from lifecycle:

**Construction phase (`create()`):**

1. Fetch available LLM models (best-effort)
2. Initialize session store and database (Drizzle migrations)
3. Initialize secret store (plain or encrypted, based on `.env.keys` presence)
4. Create extension registry and discover/load skills
5. Create core queues (Agents, Chat)
6. Create Elysia web server

**Startup phase (`start()`):**

1. Initialize all extensions (in dependency order)
2. Wire chat event broadcasting to WebSocket
3. Start web server listening
4. Start periodic log purge timer
5. Register graceful shutdown handlers

### Sandbox

The agent's shell runs inside a **just-bash** virtual filesystem. The directory configured via `AGENT_WORK_DIR` is mounted at `/home/user/work`, giving the agent full access to that directory while isolating it from the rest of the host filesystem. Skills are mounted at `/home/user/skills`. File operations within the sandbox are real (they read/write the actual `AGENT_WORK_DIR` on disk), but the agent cannot access anything outside the mounted paths.

Built-in programs: `whoami`, `date`, `uname`, `hostname`, `skill read <name>`. The `mv` command is intentionally disabled (use `cp` + `rm`).

### Job Queues

All queues use **bunqueue** (SQLite-backed) via the `ManagedQueue` abstraction. Default config: single concurrency, no auto-removal, 5-minute lock duration, stall detection disabled.

- **Agents** - General agent prompt jobs (spell-check, telegram, scheduled tasks, extension-triggered)
- **Chat** - Conversational interactions (streamed back via WebSocket)

Job logs are persisted to SQLite (`src/queue/logStore.ts`) so they survive restarts. A periodic purge timer removes orphaned log entries every 6 hours.

### Extension System

Extensions live in `src/extensions/<name>/index.ts` (or `src/extensions/core/<name>/index.ts` for core extensions) and must default-export an `Extension` object (manifest + initialize + shutdown). The registry:

1. Discovers extensions via `Bun.Glob("*/index.ts")` and `Bun.Glob("core/*/index.ts")`
2. Validates manifests with TypeBox
3. Resolves dependencies (topological sort)
4. Initializes in dependency order with a scoped `ExtensionContext`

Extensions can register: tools, HTTP routes (auto-prefixed `/ext/<name>/`), job queues, agent event listeners, skills, UI contributions (sidebar navigation entries), and dynamic item providers for settings schema enrichment. Extension config is read from `EXT_<NAME>_<KEY>` env vars.

Current extensions (11): **converter**, **error-analyzer**, **mcp**, **steering**, **telegram**, **web-fetch**, **wiki** | Core: **filewatcher**, **scheduler**, **webhooks**, **workflows**

#### Dynamic Settings Items

Extension settings schemas can declare `dynamicItems` on array properties to populate `availableItems` at request time from a named provider. This avoids hardcoding options that depend on runtime state (e.g. registered queues, available models).

Schema example:

```ts
monitoredQueues: Type.Array(Type.String(), {
  availableItems: ["agents", "chat", "workflows"],  // static fallback
  dynamicItems: "all-queue-names",              // resolved at request time
})
```

The provider registry lives in `src/web/dynamicItemProviders.ts`. Extensions register providers via `ctx.registerDynamicItemProvider(name, fn)` during initialization. The `GET /api/extensions/:name/settings` route invokes providers before returning the schema to the frontend. The frontend requires no changes since it already renders `availableItems`.

Built-in providers (registered by extensions):

- `all-queue-names` (error-analyzer) - Core queue names + extension names that have registered queues (short form, e.g. "converter" not "converter:jobs")

### Sessions

Conversation sessions are persisted in SQLite via the session store (`src/session/`). Sessions track source (chat, telegram, scheduler), messages (as pi-agent-core `AgentMessage` blobs), and metadata. The chat queue uses sessions for multi-turn context.

### Skills

Markdown files in `src/extensions/<name>/skills/<skill>/SKILL.md` (or `src/extensions/core/<name>/skills/<skill>/SKILL.md` for core extensions) with YAML frontmatter (`name`, `description`). The agent reads skills at runtime via `skill read <name>` in the sandbox shell. Skills can include `scripts/` subdirectories for sandbox programs.

### Web Server

Elysia serves the built frontend as static files and exposes:

- `GET /health` - Health check
- `POST /api/chat` - Enqueue a chat message (streamed back via WebSocket)
- `POST /api/push` - Inject out-of-band messages into a chat session
- `POST /api/queues/clean` - Clean completed/failed jobs
- `POST /api/jobs/:jobId/cancel` - Cancel a job
- `GET /api/jobs/:jobId/logs` - Retrieve job logs
- `POST /api/auth/validate` - Validate auth token
- `GET /api/extensions` - List loaded extensions
- `PUT /api/extensions/:name` - Enable/disable an extension
- `GET /api/extensions/:name/secrets` - List extension secret status (metadata only)
- `PUT /api/extensions/:name/secrets` - Upsert extension secrets
- `DELETE /api/extensions/:name/secrets/:key` - Remove an extension secret
- `GET /api/extensions/:name/secrets/audit` - Extension secret audit log
- `GET /api/secrets` - List global secrets (metadata only)
- `PUT /api/secrets` - Upsert global secrets with ACL
- `PATCH /api/secrets/:key` - Update global secret metadata (consumers, description)
- `DELETE /api/secrets/:key` - Remove a global secret
- `GET /api/secrets/audit` - Global secret audit log
- `GET /api/models` - List available LLM models
- `GET /api/models/selected` - Get currently selected model
- `PUT /api/models/selected` - Change selected model
- `GET /api/sessions/:id/messages` - Retrieve session messages
- `DELETE /api/sessions/:id/messages` - Clear session messages
- `WS /ws` - Real-time job state, chat streaming, workflow events, and extension lifecycle events
- `/ext/<name>/...` - Extension-registered routes

Auth is optional: set `AUTH_TOKEN` to enable Bearer token validation on API/WS/extension routes.

### Secrets Management

Palim has two layers of secret management:

**Boot-time environment variables** (`.env` + optional `.env.keys`):

- Loaded once at startup via `dotenvx.config()` (imported in `main.ts`)
- If `.env.keys` is present, dotenvx decrypts the `.env` file and injects all values into `process.env`
- If `.env.keys` is absent, Bun's built-in `.env` loading provides values directly
- Used for infrastructure config: `OPENAI_API_KEY`, `AUTH_TOKEN`, etc.
- No per-key ACL or audit logging (trusted core code only)

**SecretVault** (SQLite-backed, AES-256-GCM encrypted):

- Extension and workflow secrets managed via the web UI
- Per-row ACL with consumer identity pattern matching
- All access attempts are audit-logged to SQLite
- Extensions access secrets via `ctx.secrets.get(key)` / `ctx.secrets.set(key, value)`
- Workflows access secrets via `{{secret.KEY_NAME}}` template syntax
- Requires `SECRETS_MASTER_KEY` (or derivation from `.env.keys`) for encryption

## Coding Conventions

- **File naming:** camelCase for backend (`src/`, `shared/`), extension entry points are always `index.ts`
- **Validation:** TypeBox schemas (`Type.Object()`) + `Value.Check()` / `Value.Errors()` for all inputs
- **Documentation:** JSDoc on all exports with `@param`, `@returns`, `@throws`
- **File I/O:** Use `Bun.file()` / `Bun.write()` instead of `node:fs`
- **File discovery:** Use `Bun.Glob` instead of manual directory walking
- **No hardcoded URLs/ports:** Derive from `src/config.ts` or env vars
- **Tool implementation:** Implements `AgentTool` from pi-agent-core, TypeBox parameter schemas, file tools enforce path scoping to `WORK_DIR`
- **Path aliases:** `@src/*` maps to `./src/*`, `@shared/*` maps to `./shared/*`, `@ext/sdk` maps to `./src/extensions/sdk.ts`, `@ext/types` maps to `./src/extensions/types.ts`

## Common Commands

```bash
bun install              # Install dependencies
bun run setup            # Interactive first-time setup (env, LLM config, frontend build)
bun run start            # Start agent (no file watching)
bun run dev              # Start agent with file watching
bun run check            # Lint and format (Biome)
bun run cli              # Launch sandbox CLI (interactive shell)
bun run test             # Run tests
cd frontend && bun run build  # Build frontend
```
