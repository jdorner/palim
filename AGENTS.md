# AGENTS.md

## Overview

An AI agent platform called **Palim**, built on [pi-agent-core](https://github.com/earendil-works/pi/tree/main/packages/agent) and **Bun**. It combines a conversational AI agent with a job queue system, a plugin-style extension architecture, a Svelte 5 web UI, and local LLM inference via llama.cpp (direct or through llama-swap proxy).

The agent operates inside a sandboxed shell powered by just-bash. The configured `AGENT_WORK_DIR` is mounted into a virtual filesystem, giving the agent full read/write access to that directory while isolating it from the rest of the host. Skills are also mounted into the sandbox. The agent uses markdown-based skills and tasks for context and instructions.

## Quick Start

```bash
# Install dependencies
bun install

# Interactive first-time setup (creates .env, prompts for LLM config, generates admin password, builds frontend)
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
| `TRUSTED_PROXIES`      | Reverse proxy IPs/CIDRs whose `X-Forwarded-For` is trusted | - (header ignored) |
| `EXTENSIONS_DIR`       | Custom extensions directory                    | `src/extensions`           |
| `AUTH_ADMIN_USER`      | Username of the admin seeded on first boot     | `admin`                    |
| `AUTH_ADMIN_PASSWORD`  | Seeded admin password (empty = generate + log) | -                          |
| `AUTH_SESSION_TTL_MS`  | Login token lifetime (ms)                      | `604800000` (7 days)       |
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
│   ├── extensionRouter.ts   # Runtime extension route table, dispatched via a fixed /ext/* mount
│   ├── dynamicProviders.ts  # Provider registry for dynamic schema enrichment (items + defaults)
│   ├── monitor.ts           # Real-time job state push to WS clients
│   ├── auth.ts              # Bearer token auth middleware, client IP resolution (trusted proxies)
│   ├── loginThrottle.ts     # Per-IP + per-username login failure lockouts
│   ├── chatEvents.ts        # Agent event to chat WS event mappingg
│   ├── sessionChatMap.ts    # In-memory session-to-chat mapping for push routing
│   └── routes/
│       ├── auth.ts          # POST /api/auth/login|logout, GET /api/auth/me
│       ├── chat.ts          # POST /api/chat
│       ├── extensions.ts    # GET/PUT /api/extensions (settings with dynamic item enrichment)
│       ├── jobs.ts          # Job cancel, logs, queue clean endpoints
│       ├── models.ts        # GET/PUT /api/models (selection + listing)
│       ├── push.ts          # POST /api/push (out-of-band message injection)
│       ├── secrets.ts       # Extension secret CRUD + audit log
│       ├── globalSecrets.ts # Global secret CRUD + audit log
│       ├── globalVariables.ts # Global variable CRUD (plaintext, no ACL)
│       └── sessions.ts      # GET/DELETE /api/sessions/:id/messages
├── extensions/
│   ├── types.ts             # Public extension API (Extension, ExtensionContext)
│   ├── publicTypes.ts       # Public-facing type definitions for extension authors
│   ├── internalTypes.ts     # Internal registry types (not for extension authors)
│   ├── sdk.ts               # Extension SDK re-exports
│   ├── index.ts             # Barrel re-export (registry + public types)
│   ├── engine/              # Extension engine internals (not extension code)
│   │   ├── registry.ts      # Discovery, validation, dependency resolution, lifecycle
│   │   ├── discovery.ts     # Extension directory discovery (Bun.Glob)
│   │   ├── lifecycle.ts     # Initialize/shutdown orchestration
│   │   ├── extensionContext.ts # Scoped context factory per extension
│   │   ├── eventBus.ts      # Agent lifecycle event dispatch
│   │   ├── dependencyResolver.ts # Topological sort for load order
│   │   ├── externalDependencyResolver.ts # Dependency resolution for external/dynamic extensions
│   │   ├── extensionWatcher.ts # Hot-load/unload watcher for external extensions
│   │   ├── configResolver.ts # Resolves EXT_<NAME>_<KEY> config from env
│   │   └── stepTypeSerialization.ts # Serializes custom step types (with dynamic enrichment)
│   ├── core/                # Core extensions (non-deactivatable infrastructure)
│   │   ├── filewatcher/     # Directory watchers emitting domain events
│   │   ├── scheduler/       # Cron/interval-based job scheduling
│   │   ├── webhooks/        # Authenticated HTTP endpoints for external events
│   │   └── workflows/       # DAG job pipelines (JSON5: steps map + edges array)
│   ├── core-wf-steps/       # Core (top-level): built-in workflow step types
│   └── <name>/index.ts      # Optional extensions (see list below)
├── secrets/
│   ├── vault.ts             # SecretVault: SQLite-backed AES-256-GCM encrypted storage with per-row ACL
│   ├── vaultSchema.ts       # Drizzle schema for secrets_vault table
│   ├── acl.ts               # Pattern matching for consumer identity ACL checks
│   ├── audit.ts             # SQLite-backed secret access audit log
│   ├── types.ts             # SecretResolution, SecretAclEntry, SecretAuditRecord, SetSecretOptions
│   └── index.ts             # Re-exports
├── variables/
│   ├── store.ts             # VariableStore: SQLite-backed plaintext global variables (no ACL, no encryption)
│   ├── variablesSchema.ts   # Drizzle schema for global_variables table
│   ├── types.ts             # GlobalVariableEntry re-export for backend use
│   └── index.ts             # Re-exports
├── skills/
│   ├── skills.ts            # Skill directory loading and system prompt building
│   ├── frontmatter.ts       # YAML frontmatter parsing for skill markdown
│   └── index.ts             # Re-exports
├── types/
│   └── subscript-justin.d.ts # Ambient types for the subscript Justin preset
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

shared/                      # Types + pure helpers shared between backend and frontend,
│                            # split into domain modules and re-exported from index.ts
├── index.ts                 # Barrel re-export of all shared modules
├── types.ts                 # Backward-compatible re-export (legacy import path)
├── chat.ts                  # ChatWebSocketEvent, TokenUsage
├── extensions.ts            # ExtensionInfo, ExtensionLifecycleEvent, ExtensionUiContribution, NavigationEntry, ...
├── jobs.ts                  # JobEntry, LogEntry
├── models.ts                # AvailableModel, ModelIntent, SelectedModelResponse, MODEL_INTENTS
├── schedules.ts             # ScheduleEntry
├── variables.ts             # GlobalVariableEntry
├── websocket.ts             # WebSocketMessage, ApprovalRequestEvent, PushMessageEvent
├── workflows.ts             # WorkflowWebSocketEvent, WorkflowStepSummary, OutputSchema(s), walkSchemaPath, DEFAULT_ENV_ALLOWLIST
├── workflowBuilder.ts       # WorkflowBuilder + builder draft types (BUILTIN_STEP_TYPES, getDescriptor)
└── templateFunctionMeta.ts  # Pure metadata table for built-in template functions (name,
                             #  signature, description, returnType). Single source of truth for
                             #  valid function names, consumed by the backend runtime registry
                             #  and the frontend autocomplete (import-safe from both).

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
    │   ├── StepConfigForm, TemplateAutocomplete, MultiSelect
    │   ├── WebhookList, FileWatcherList
    │   ├── ModelSelector, IntentModelSelector, Sidebar
    │   ├── GlobalSecretForm, SecretForm, PushSegment, StatusDot, AddStepNode
    │   └── ...
    └── lib/                 # Stores, auth, UI primitives
        ├── appStore.ts, auth.ts, chatStore.ts
        ├── badgeRegistry.ts, extensionStore.ts, iconRegistry.ts
        ├── chatStreamStore.svelte.ts, connectionStore.svelte.ts
        ├── modelStore.svelte.ts, readState.svelte.ts, settingsStore.svelte.ts
        ├── workflowRunStore.svelte.ts, workflowValidation.ts
        ├── autocompleteEngine.ts, schemaForm.ts, templateScope.ts, stepTypes.ts
        ├── utils.ts
        └── components/      # Reusable UI (shadcn-style primitives)

WORK_DIR/                       # AGENT_WORK_DIR - the agent's workspace (real directory mounted into sandbox)
├── inbox/                   # Drop files here for auto-processing (OCR)
├── outbox/                  # Processed file output
├── data/                    # Agent data files (wiki, error reports, etc.)
├── tasks.md                 # Task list ([ ] open, [x] done, [p] in progress)
└── workflows/               # Workflow pipeline definitions (JSON5 DAG)
```

## Architecture

### Boot Sequence (`src/app/boot.ts`)

The `AppBootstrap` class separates construction from lifecycle:

**Construction phase (`create()`):**

1. Fetch available LLM models (best-effort)
2. Initialize session store and database (Drizzle migrations)
3. Initialize secret store (plain or encrypted, based on `.env.keys` presence)
4. Initialize variable store (plaintext global variables, always available - no master key)
5. Create extension registry and discover/load skills
6. Create core queues (Agents, Chat)
7. Create Elysia web server

**Startup phase (`start()`):**

1. Initialize all extensions (in dependency order)
2. Wire chat event broadcasting to WebSocket
3. Start web server listening
4. Start periodic log purge timer
5. Register graceful shutdown handlers

### Sandbox

The agent's shell runs inside a **just-bash** virtual filesystem. The directory configured via `AGENT_WORK_DIR` is mounted at `/home/user/work`, giving the agent full access to that directory while isolating it from the rest of the host filesystem. Skills are mounted at `/home/user/skills`. File operations within the sandbox are real (they read/write the actual `AGENT_WORK_DIR` on disk), but the agent cannot access anything outside the mounted paths.

Built-in programs: `skill` (subcommands: `read <name>`, `list`), `push` (available when a session ID is set; sends content to the chat UI). Extension skills can register additional programs via `registerProgram`.

### Job Queues

All queues use **bunqueue** (SQLite-backed) via the `ManagedQueue` abstraction. Default config: single concurrency, no auto-removal, 5-minute lock duration, stall detection disabled.

- **Agents** - General agent prompt jobs (spell-check, telegram, scheduled tasks, extension-triggered)
- **Chat** - Conversational interactions (streamed back via WebSocket)

Job logs are persisted to SQLite (`src/queue/logStore.ts`) so they survive restarts. A periodic purge timer removes orphaned log entries every 6 hours.

### Workflows (DAG engine)

Workflows (`src/extensions/core/workflows/`) are directed acyclic graphs: a `steps` map (keyed by slug) plus an `edges` array (`from`, `to`, optional `branch`). The engine dispatches all root steps in parallel, then dispatches each successor once all its incoming edges are resolved (`satisfied` or `dead`, at least one `satisfied` — the join barrier). Control-flow nodes (`if`/`case`) are evaluated inline and mark their branch edges satisfied/dead; dead edges propagate to skip unreachable steps. Any step failure fails the whole run (fail-fast) and cancels in-flight jobs. Per-run edge states, step statuses, and results are persisted in SQLite. The `http-request`, `fail`, `noop`, `chunk`, `set-variables`, and `start-workflow` step types are provided by the `core-wf-steps` extension.

#### Template Expressions

Workflow string fields, agent prompts, and `if`/`case`/`iterator` expressions support `{{...}}` template expressions resolved by `src/extensions/core/workflows/template.ts`. Beyond plain dot-path lookups (`{{ trigger.payload }}`, `{{ steps.fetch.result.data }}`), expressions support composable function calls (`{{ jsonEscape(stripDataUri(image.dataUrl)) }}`):

- **Built-in function registry** (`templateFunctions.ts`): pure, deterministic helpers - `stripDataUri`, `base64Decode`, `jsonEscape`, `after`, `before`, `trim`, `nowIso`. The valid-name set is derived from the shared, pure metadata table `shared/templateFunctionMeta.ts` (a load-time assertion guards against drift), so the evaluator, the load-time validator, and the frontend autocomplete all agree on which functions exist.
- **Namespaces**: beyond `trigger`/`steps`, expressions resolve `{{env.<VAR>}}` (environment variable), `{{secret.<KEY>}}` (encrypted vault secret, ACL-checked, decrypted at access), and `{{var.<KEY>}}` (plaintext global variable from the `VariableStore` - no decryption, no ACL). Missing variables and secrets are left literal with a warning.
- **Sandboxed evaluation** (`templateEval.ts`): expressions are evaluated by `subscript` (Justin preset). Guarded namespaces (`secret`, `env`) are resolved (ACL/allowlist) BEFORE evaluation and never placed in the evaluated scope; `var` is exposed as a lazy null-prototype proxy backed by the resolver. Unresolvable paths, unknown functions, and parse errors leave the expression literal with a warning.
- **Load-time validation** (`dagTemplateValidation.ts`): parses function-call syntax and validates argument paths under the same namespace rules, sharing the function-name allowlist so validation cannot diverge from evaluation. Warnings are advisory (surfaced non-blocking on the workflow list/detail API).
- **Frontend autocomplete** (`frontend/src/lib/autocompleteEngine.ts`, `templateScope.ts`): the `{{...}}` editor offers namespaces and built-in functions (sourced from the shared metadata) in value positions, classifies path vs function-argument cursor context, and closes open call parentheses when completing a value inside a call.

### Extension System

Extensions live in `src/extensions/<name>/index.ts` (or `src/extensions/core/<name>/index.ts` for core extensions) and must default-export an `Extension` object (manifest + initialize + shutdown). The registry:

1. Discovers extensions via `Bun.Glob("*/index.ts")` and `Bun.Glob("core/*/index.ts")`
2. Validates manifests with TypeBox
3. Resolves dependencies (topological sort)
4. Initializes in dependency order with a scoped `ExtensionContext`

Extensions can register: tools, HTTP routes (auto-prefixed `/ext/<name>/`; pass `{ public: true }` for self-authenticating callbacks), job queues, agent event listeners, skills, UI contributions (sidebar navigation entries), custom workflow step types (with optional input validation), and dynamic item providers for settings schema enrichment. Extension config is read from `EXT_<NAME>_<KEY>` env vars.

Extension routes are not mounted on Elysia directly (Elysia cannot add routes after `listen()`). The web server mounts a fixed `/ext/*` catch-all that dispatches through `ExtensionRouter` (`src/web/extensionRouter.ts`); routes are added on registration and removed on deactivate/unload, so enabling, re-enabling, or hot-loading an extension at runtime takes effect immediately. The router parses the body per the route's `parse` option from a clone of the request, so handlers can still read `request` directly.

Current extensions (13): **converter**, **error-analyzer**, **mcp**, **ntfy**, **steering**, **telegram**, **web-fetch**, **wiki** | Core: **core-wf-steps**, **filewatcher**, **scheduler**, **webhooks**, **workflows**

#### Dynamic Schema Enrichment

Extension settings schemas (and custom step type config schemas) can declare named providers that are resolved at request time, avoiding hardcoded options that depend on runtime state (e.g. registered queues, available models, discovered binary paths). Two provider kinds:

- `dynamicItems` on an **array** property populates its `availableItems` (provider returns `string[]`).
- `dynamicDefault` on a **scalar string** property replaces its `default` (provider returns `string`; an empty string leaves the static default untouched). Use it to surface a runtime-discovered value as an editable field default.

Schema example:

```ts
monitoredQueues: Type.Array(Type.String(), {
  availableItems: ["agents", "chat", "workflows"],  // static fallback
  dynamicItems: "all-queue-names",                  // resolved at request time
}),
fpcalcPath: Type.String({
  default: "",                                      // static fallback
  dynamicDefault: "music-metadata-fpcalc-path",     // resolved at request time
})
```

The provider registry lives in `src/web/dynamicProviders.ts` (`enrichSchema` applies both facets). Extensions register providers via `ctx.dynamicItems.register(name, fn)` (items) and `ctx.dynamicItems.registerDefault(name, fn)` (defaults) during initialization. The `GET /api/extensions/:name/settings` route and the registry's step-type serialization invoke providers before returning schemas to the frontend. The frontend requires no changes since it already renders `availableItems` and `default`.

Built-in providers (registered by extensions):

- `all-queue-names` (error-analyzer) - Core queue names + extension names that have registered queues (short form, e.g. "converter" not "converter:jobs")
- `workflow-names` (core-wf-steps) - Names of all loaded workflow definitions, populating the `workflowName` dropdown on the `start-workflow` step

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
- `POST /api/auth/login` - Exchange username/password for a bearer token
- `POST /api/auth/logout` - Revoke the presented token
- `GET /api/auth/me` - Current user and serialized ability
- `GET/POST/PATCH/DELETE /api/users` - User management (admin; delete also removes the user's chat sessions and is refused while they still own webhooks, file watchers, or schedules)
- `GET/POST /api/roles`, `PATCH/DELETE /api/roles/:id`, `PUT /api/roles/:id/permissions` - Role management (admin; delete only for unassigned custom roles)
- `GET /api/extensions` - List loaded extensions
- `PUT /api/extensions/:name` - Enable/disable an extension
- `GET /api/extensions/:name/secrets` - List extension secret status (metadata only)
- `PUT /api/extensions/:name/secrets` - Upsert extension secrets
- `DELETE /api/extensions/:name/secrets/:key` - Remove an extension secret
- `GET /api/extensions/:name/secrets/audit` - Extension secret audit log
- `GET /api/secrets` - List global secrets (metadata only)
- `POST /api/secrets` - Create global secrets with ACL (409 if a key already exists)
- `PUT /api/secrets` - Upsert global secrets with ACL
- `PATCH /api/secrets/:key` - Update global secret metadata (consumers, description)
- `DELETE /api/secrets/:key` - Remove a global secret
- `GET /api/secrets/audit` - Global secret audit log
- `GET /api/variables` - List global variables (full plaintext values)
- `POST /api/variables` - Create global variables (409 if a key already exists)
- `PUT /api/variables` - Upsert global variables with optional descriptions
- `DELETE /api/variables/:key` - Remove a global variable (workflow-reference check; `confirm=true` to force)
- `GET /api/models` - List available LLM models
- `GET /api/models/selected` - Get currently selected model
- `PUT /api/models/selected` - Change selected model
- `GET /api/sessions/:id/messages` - Retrieve session messages
- `DELETE /api/sessions/:id/messages` - Clear session messages
- `WS /ws` - Real-time job state, chat streaming, workflow events, and extension lifecycle events
- `/ext/<name>/...` - Extension-registered routes

Rate limiting: authenticated requests are limited per token (1000/min), so a user's browser session and the internal token their agent jobs use get separate buckets; everything else is limited per client IP (60/min). Failed logins are additionally throttled per IP and per username with exponential lockouts (`src/web/loginThrottle.ts`). Behind a reverse proxy, set `TRUSTED_PROXIES` so the client IP is taken from `X-Forwarded-For`.

Auth is always on: all `/api/` and `/ext/` routes (except login, health, and extension routes registered with `{ public: true }`, such as webhook receive) and the WebSocket require a per-user bearer token. Every user can read everything except other users' chat sessions; roles map to write/management permissions (RBAC). See `docs/api-security-model.md`.

### Secrets Management

Palim has two layers of secret management:

**Boot-time environment variables** (`.env` + optional `.env.keys`):

- Loaded once at startup via `dotenvx.config()` (imported in `main.ts`)
- If `.env.keys` is present, dotenvx decrypts the `.env` file and injects all values into `process.env`
- If `.env.keys` is absent, Bun's built-in `.env` loading provides values directly
- Used for infrastructure config: `OPENAI_API_KEY`, `AUTH_ADMIN_PASSWORD`, etc.
- No per-key ACL or audit logging (trusted core code only)

**SecretVault** (SQLite-backed, AES-256-GCM encrypted):

- Extension and workflow secrets managed via the web UI
- Per-row ACL with consumer identity pattern matching
- All access attempts are audit-logged to SQLite
- Extensions access secrets via `ctx.secrets.get(key)` / `ctx.secrets.set(key, value)`
- Workflows access secrets via `{{secret.KEY_NAME}}` template syntax
- Requires `SECRETS_MASTER_KEY` (or derivation from `.env.keys`) for encryption

### Global Variables

Separate from the SecretVault, Palim has a `VariableStore` (`src/variables/`) for **non-sensitive** configuration shared across workflows:

- SQLite-backed (`global_variables` table, Drizzle migration `0009`), stored in **plaintext** - no encryption, no per-row ACL, no audit logging
- Managed via the web UI and the `GET/POST/PUT/DELETE /api/variables` routes; listings return full unmasked values
- Referenced in workflow templates via `{{var.KEY_NAME}}` syntax (resolved by the same template engine as `secret`/`env`)
- Constructed unconditionally during boot (no master key required) and injected into the web server and extension contexts

## Coding Conventions

- **File naming:** camelCase for backend (`src/`, `shared/`), extension entry points are always `index.ts`
- **Validation:** TypeBox schemas (`Type.Object()`) + `Value.Check()` / `Value.Errors()` for all inputs
- **Documentation:** JSDoc on all exports with `@param`, `@returns`, `@throws`
- **File I/O:** Use `Bun.file()` / `Bun.write()` instead of `node:fs`
- **File discovery:** Use `Bun.Glob` instead of manual directory walking
- **No hardcoded URLs/ports:** Derive from `src/config.ts` or env vars
- **Tool implementation:** Implements `AgentTool` from pi-agent-core, TypeBox parameter schemas, file tools enforce path scoping to `WORK_DIR`
- **Path aliases:** `@src/*` maps to `./src/*`, `@shared/*` maps to `./shared/*`, `@ext/sdk` maps to `./src/extensions/sdk.ts`, `@ext/types` maps to `./src/extensions/types.ts`
- **Type checking:** Always run `bunx tsc --noEmit` without file arguments. Never pass individual files to tsc — it ignores tsconfig.json when files are specified on the command line.

## Common Commands

```bash
bun install              # Install dependencies
bun run setup            # Interactive first-time setup (env, LLM config, admin password, frontend build)
bun run start            # Start agent (no file watching)
bun run dev              # Start agent with file watching
bun run check            # Lint and format (Biome)
bun run cli              # Launch sandbox CLI (interactive shell)
bun run test             # Run tests
bun run reset-admin [username]   # Break-glass: re-enable user, grant admin, print new password
cd frontend && bun run build  # Build frontend
```
