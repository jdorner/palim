# Writing Extensions

Extensions are self-contained modules that hook into the agent system. Each extension can register tools, HTTP routes, job queues, and agent event subscriptions through the `ExtensionContext` interface.

## Table of Contents

- [Import Rules](#import-rules)
- [Getting Started](#getting-started)
  - [Minimal Extension](#minimal-extension)
- [External Extensions](#external-extensions)
  - [How It Works](#how-it-works)
  - [package.json](#packagejson)
  - [Generated tsconfig.json](#generated-tsconfigjson)
  - [Runtime Resolution](#runtime-resolution)
  - [Discovery and Loading](#discovery-and-loading)
  - [Error Handling](#error-handling)
- [ExtensionContext API](#extensioncontext-api)
  - [Top-Level Properties](#top-level-properties)
  - [Tools (`ctx.tools`)](#tools-ctxtools)
  - [Routes (`ctx.routes`)](#routes-ctxroutes)
  - [Route Naming Convention](#route-naming-convention)
  - [Queues (`ctx.queues`)](#queues-ctxqueues)
  - [Events (`ctx.events`)](#events-ctxevents)
  - [Messaging (`ctx.messaging`)](#messaging-ctxmessaging)
  - [UI Events (`ctx.ui`)](#ui-events-ctxui)
  - [Workflows (`ctx.workflows`)](#workflows-ctxworkflows)
  - [Agent Execution (`ctx.agent`)](#agent-execution-ctxagent)
  - [Config (`ctx.config`)](#config-ctxconfig)
  - [Secrets (`ctx.secrets`)](#secrets-ctxsecrets)
  - [Skills (`ctx.skills`)](#skills-ctxskills)
  - [Step Types (`ctx.stepTypes`)](#step-types-ctxsteptypes)
  - [Dynamic Items (`ctx.dynamicItems`)](#dynamic-items-ctxdynamicitems)
  - [State](#state)
  - [Internal (Core Extensions Only)](#internal-core-extensions-only)
- [Configuration](#configuration)
  - [Settings Schema](#settings-schema)
- [Logging](#logging)
- [Registering Tools](#registering-tools)
- [Running Sub-Agents](#running-sub-agents)
- [Database Access](#database-access)
- [Skills](#skills)
  - [Using `ctx.registerProgram`](#using-ctxregisterprogram)
- [Dependencies](#dependencies)
- [Custom Workflow Step Types](#custom-workflow-step-types)
  - [Registering a Step Type](#registering-a-step-type)
  - [StepTypeHandler Interface](#steptypehandler-interface)
  - [Declaring Output Schemas](#declaring-output-schemas)
  - [Input Validation (Pre-Transition Checks)](#input-validation-pre-transition-checks)
  - [StepExecutionContext](#stepexecutioncontext)
  - [Template Expressions Available](#template-expressions-available)
  - [Using Custom Steps in Workflows](#using-custom-steps-in-workflows)
  - [Frontend Rendering](#frontend-rendering)
  - [Step Type Error Handling](#step-type-error-handling)
  - [Constraints](#constraints)
- [Extension UI](#extension-ui)
  - [Sidebar Navigation](#sidebar-navigation)
  - [Svelte Pages](#svelte-pages)
  - [The `palim` Host API](#the-palim-host-api)
  - [UI Kit and Styling](#ui-kit-and-styling)
  - [Server Events](#server-events)
  - [Build, Caching, and Hot Reload](#build-caching-and-hot-reload)
  - [Page Rules](#page-rules)
- [Lifecycle Summary](#lifecycle-summary)
  - [Enable / Disable (Runtime)](#enable--disable-runtime)
  - [Unload (Extension Removal)](#unload-extension-removal)
  - [Core Extensions](#core-extensions)

## Import Rules

Extensions must **not** import from `@src/` paths. This boundary is enforced by a Biome lint rule.

Allowed imports:

| What you need | Import from |
| --- | --- |
| Extension API types (`Extension`, `ExtensionContext`, `QueueJob`, etc.) | `@ext/types` |
| Skill script utilities (`createCommand`, `SkillScriptContext`, etc.) | `@ext/sdk` |
| Files within your own extension | `./store`, `./schema`, etc. |
| External npm packages | `@sinclair/typebox`, `drizzle-orm`, etc. |
| Node built-ins | `node:path`, `node:fs`, etc. |

Everything an extension needs from the core is available through `ExtensionContext` or the SDK module.

## Getting Started

Create a new directory under `src/extensions/` with an `index.ts` that default-exports an `Extension` object:

```text
src/extensions/
├── core/              # Core extensions (non-deactivatable)
│   ├── filewatcher/
│   ├── scheduler/
│   ├── webhooks/
│   └── workflows/
└── my-extension/      # Optional extensions live at the top level
    └── index.ts
```

The registry discovers extensions automatically at startup - just drop your folder in and restart. Core extensions (in `core/`) set `core: true` in their manifest and cannot be disabled.

### Minimal Extension

```typescript
import type { Extension } from "@ext/types";

const extension: Extension = {
  manifest: {
    name: "my-extension",   // lowercase, hyphens allowed: ^[a-z][a-z0-9-]*$
    version: "1.0.0",
    dependencies: [],       // optional - names of extensions that must load first
    // core: true,          // optional - prevents disabling via UI/API
  },

  async initialize(ctx) {
    // Register tools, routes, queues, events here
  },

  async shutdown() {
    // Clean up resources (connections, timers, etc.)
  },
};

export default extension;
```

## External Extensions

Extensions can also live **outside** the core project tree, in `AGENT_WORK_DIR/.palim/extensions/`. This is useful for project-specific or user-specific extensions that should not be committed to the core repository.

```text
.palim/extensions/
├── my-extension/
│   ├── index.ts          # Extension entry point (same structure as built-in)
│   ├── package.json      # Dependency declarations
│   ├── tsconfig.json     # Auto-generated (do not edit)
│   ├── schema.ts         # Optional database schema
│   └── skills/           # Optional bundled skills
│       └── my-skill/
│           ├── SKILL.md
│           └── scripts/
│               └── my-command.ts
└── another-extension/
    └── index.ts
```

External extensions use the exact same `Extension` interface and `@ext/types` / `@ext/sdk` imports as built-in extensions. The system handles TypeScript resolution and dependency management automatically.

### How It Works

At boot (before extension initialization), the system runs an `ExternalDependencyResolver` that:

1. **Generates `tsconfig.json`** in each external extension directory with path aliases (`@ext/types`, `@ext/sdk`, `@src/*`, `@shared/*`) pointing back to the core project's source files, and `typeRoots` pointing to the core project's `node_modules`. This gives your IDE full type checking and autocompletion.

2. **Installs dependencies** declared in the extension's `package.json` by running `bun install` in the extension directory.

3. **Validates peer dependencies** against the core project's installed packages and logs warnings for any missing ones.

The resolver also runs when an extension is hot-loaded at runtime via `loadOne()`.

### package.json

Each external extension should have a `package.json`. Use `dependencies` for packages the extension needs that are NOT in the core project, and `peerDependencies` for packages you rely on from the host:

```json
{
  "name": "my-extension",
  "module": "index.ts",
  "type": "module",
  "dependencies": {
    "some-niche-package": "^2.0.0"
  },
  "peerDependencies": {
    "drizzle-orm": "^0.45.2",
    "@sinclair/typebox": "^0.34.52"
  }
}
```

**Dependency resolution rules:**

- **Peer dependencies** are verified to exist in the core project's `node_modules` but never installed separately. If missing, a warning is logged.
- **Dependencies matching a host package** at a compatible version are skipped (no duplication). The core's copy is reused at runtime.
- **Dependencies not in the host** are installed into the extension's local `node_modules/`.
- **Version conflicts** (extension requests a range incompatible with the installed host version) are logged as warnings, and the extension's version is installed locally.

### Generated tsconfig.json

The auto-generated `tsconfig.json` looks like this (paths are relative to your extension directory):

```json
{
  "_managed": true,
  "compilerOptions": {
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "skipLibCheck": true,
    "typeRoots": ["<relative-path>/node_modules/@types"],
    "paths": {
      "@ext/types": ["<relative-path>/src/extensions/types.ts"],
      "@ext/sdk": ["<relative-path>/src/extensions/sdk.ts"],
      "@ext/ui": ["<relative-path>/src/extensions/ui/index.ts"],
      "@palim/ui": ["<relative-path>/frontend/src/lib/extensionKit.ts"],
      "$lib/*": ["<relative-path>/frontend/src/lib/*"],
      "*": ["./node_modules/*", "<relative-path>/node_modules/*"]
    }
  },
  "include": ["./**/*.ts", "./**/*.svelte"],
  "exclude": ["node_modules"]
}
```

**Important:** Do not manually edit this file. The resolver overwrites it on every boot (detected by `"_managed": true`). If you need a custom tsconfig, set `"_managed": false` at the root level — the resolver will then leave your file untouched.

### Runtime Resolution

At runtime, external extensions are loaded via dynamic `import()` from the core process. This means:

- Bun resolves modules relative to the core project's context, so host packages "just work" without needing them in the extension's `node_modules`.
- Extension-specific packages installed in the extension's `node_modules/` are also resolvable (Bun checks local `node_modules` first, then walks up).
- The `tsconfig.json` only affects **TypeScript tooling** (IDE, type checker) — it has no effect at runtime.

### Discovery and Loading

External extensions are discovered at boot by scanning `EXTERNAL_EXTENSIONS_DIR` for `*/index.ts` patterns. They go through the same validation, dependency resolution (topological sort), and initialization flow as built-in extensions.

**Hot loading:** a filesystem watcher picks up changes in `.palim/extensions/` at runtime (debounced by one second):

- A new folder with an `index.ts` is loaded; a removed folder (or removed `index.ts`) is unloaded.
- A changed `index.ts` reloads the extension (unload, then load).
- Changes below `<extension>/ui/` only rebuild the extension's [UI pages](#extension-ui), and open pages remount with the new code.

Other files (helpers imported by `index.ts`) do not trigger a reload; touch `index.ts` to reload after editing them.

### Error Handling

- If `bun install` fails for an extension, that extension is skipped during initialization (other extensions still load normally).
- If the tsconfig cannot be written (permissions, disk full), a warning is logged and the extension still loads (runtime works fine, but IDE may show errors).
- If `package.json` is malformed, the extension is skipped entirely.

## ExtensionContext API

Every extension receives a scoped `ExtensionContext` during `initialize()`. The API is organized into namespaces for discoverability.

### Top-Level Properties

| Property | Type | Description |
| --- | --- | --- |
| `ctx.log` | `Logger` | Pre-scoped logger (`ext:{name}`) |
| `ctx.paths.work` | `string` | Absolute path to the agent's work directory |
| `ctx.paths.data` | `string` | Absolute path to the data directory (databases, generated content) |
| `ctx.paths.extensions` | `string` | Absolute path to the extensions directory |
| `ctx.db` | `BunSQLiteDatabase` | Shared Drizzle database instance |
| `ctx.fetch` | `typeof fetch` | Identity-bound fetch - authenticates internal calls as the initiating user, confined to this extension's routes; external URLs pass through |
| `ctx.sessions` | `SessionStorePort` | Shared session store for conversation persistence |

Use `ctx.fetch` instead of the global `fetch()` when calling your extension's own routes. It authenticates as the user who started the current job (or the built-in `system` account for background work) without exposing a token. Local requests are confined to `/ext/<name>/*` plus `/api/push`; any other local path returns `403`.

```typescript
async initialize(ctx) {
  // Call this extension's own route (ctx.urls.base = <origin>/ext/<name>)
  const res = await ctx.fetch(`${ctx.urls.base}/items`);
  const items = res.ok ? await res.json() : [];

  // External URLs pass through without modification
  const external = await ctx.fetch("https://api.example.com/data");
}
```

### Tools (`ctx.tools`)

| Method | Description |
| --- | --- |
| `ctx.tools.register(tool)` | Register an agent tool (unique name required) |
| `ctx.tools.names()` | Get all registered tool names (core + extensions) |

### Routes (`ctx.routes`)

| Method | Description |
| --- | --- |
| `ctx.routes.register(method, path, handler, options?)` | Register an HTTP route (auto-prefixed `/ext/{name}/`). `options.parse` selects body parsing; `options.public: true` skips token auth for self-authenticating callbacks (webhooks, OAuth redirects) |

### Route Naming Convention

Routes are auto-prefixed with `/ext/{extensionName}/`, so extensions only register the suffix. Use standard REST conventions with the extension name acting as the resource noun:

```text
GET    /ext/{name}           -> list all resources
POST   /ext/{name}           -> create a resource
GET    /ext/{name}/:id       -> get one resource
PUT    /ext/{name}/:id       -> update a resource
DELETE /ext/{name}/:id       -> delete a resource
```

For extensions managing multiple resource types or needing sub-resources, nest them directly:

```text
GET    /ext/mcp/servers              -> list servers
POST   /ext/mcp/servers/:name/sync   -> trigger a sync
GET    /ext/scheduler/schedules      -> list schedules
POST   /ext/scheduler/schedules      -> create a schedule
```

Avoid unnecessary prefixes like `/admin/` - all extension routes are already behind auth.

### Queues (`ctx.queues`)

| Method | Description |
| --- | --- |
| `ctx.queues.create(name, processor, opts?)` | Create a managed job queue (auto-prefixed `{name}:`) |
| `ctx.queues.names()` | Get all registered queue names (core + extension) |
| `ctx.queues.onEvent(queueName, event, cb)` | Subscribe to events on any queue |
| `ctx.queues.offEvent(queueName, event, cb)` | Unsubscribe from queue events |
| `ctx.queues.getJobLogs(queueName, jobId)` | Read log entries from a job |
| `ctx.queues.getFlowProducer()` | Get the shared FlowProducer for job chains |

### Events (`ctx.events`)

| Method | Description |
| --- | --- |
| `ctx.events.on(type, callback)` | Subscribe to agent lifecycle or domain events on the shared bus |
| `ctx.events.emit(event)` | Emit a domain event on the shared bus |

### Messaging (`ctx.messaging`)

| Method | Description |
| --- | --- |
| `ctx.messaging.broadcast(message)` | Push a WebSocket message to all frontend clients |
| `ctx.messaging.push(sessionId, content, opts?)` | Send a push message to a session |

### UI Events (`ctx.ui`)

| Method | Description |
| --- | --- |
| `ctx.ui.emit(event, data?)` | Send an event to this extension's open [UI pages](#extension-ui) (received via `palim.onEvent`). Delivered to every connected client: no secrets or per-user data |

### Workflows (`ctx.workflows`)

| Method | Description |
| --- | --- |
| `ctx.workflows.dispatch(name, payload?)` | Trigger a named workflow run and return the run ID + step job IDs |
| `ctx.workflows.names()` | List the names of all currently loaded workflow definitions |

Dispatch a workflow programmatically without HTTP self-calls. The method looks up the workflow definition by name, validates it is enabled, creates a run with the provided payload as trigger data, and broadcasts a `workflow_started` WebSocket event.

`ctx.workflows.names()` returns the names of all loaded workflow definitions from the live in-memory store, so it stays current across hot-reloads. It returns an empty array if the workflows extension has not initialized yet. This is handy for populating editor dropdowns (via a dynamic item provider) or validating workflow references. The `core-wf-steps` `start-workflow` step uses it for both.

```typescript
async initialize(ctx) {
  ctx.routes.register("POST", "/process", async (reqCtx) => {
    const body = reqCtx.body as { filePath: string };

    const result = await ctx.workflows.dispatch("invoice-process", {
      filePath: body.filePath,
      project: "default",
    });

    return Response.json({
      workflowRunId: result.workflowRunId,
      jobIds: result.jobIds,
    });
  });
}
```

**Error cases:**

| Condition | Error message |
| --- | --- |
| Workflow name not found in loaded definitions | `Workflow not found: <name>` |
| Workflow exists but has `enabled: false` | `Workflow is disabled: <name>` |
| Called before the workflows core extension initializes | `Workflows extension not initialized` |

Extensions that use `ctx.workflows.dispatch()` should declare `"workflows"` in their manifest `dependencies` to ensure correct initialization order.

### Agent Execution (`ctx.agent`)

| Method | Description |
| --- | --- |
| `ctx.agent.run(job, opts)` | Run a sub-agent synchronously within a queue job. Core owns model, API key, and shell. |
| `ctx.agent.enqueue(name, data)` | Submit a job to the core Agents queue (fire-and-forget). Returns job ID. |

`ctx.agent.run` is for extensions that process their own queue jobs and need an agent inline. `ctx.agent.enqueue` is for extensions that want to trigger agent work asynchronously.

Both accept an optional model `intent` (`"chat"`, `"vision"`, `"embedding"`) to run on the model selected for that intent instead of the default. For `enqueue`, if the intent's model cannot be resolved (e.g. no vision-capable model), the job logs a warning and falls back to the default model; images in the session are then replaced with a placeholder.

### Config (`ctx.config`)

| Method | Description |
| --- | --- |
| `ctx.config.get(key, default?)` | Read `EXT_{NAME}_{KEY}` env var (auto-coerced) or persisted setting |

### Secrets (`ctx.secrets`)

| Method | Description |
| --- | --- |
| `ctx.secrets.get(key)` | Retrieve a secret (ACL-checked, audited) |
| `ctx.secrets.set(key, value, opts?)` | Store an encrypted secret |

### Skills (`ctx.skills`)

| Method | Description |
| --- | --- |
| `ctx.skills.resolve(name)` | Resolve a skill name to its entry |
| `ctx.skills.names()` | Get names of all loaded skills from enabled extensions |
| `ctx.skills.rescan()` | Trigger full skill re-discovery |

### Step Types (`ctx.stepTypes`)

| Method | Description |
| --- | --- |
| `ctx.stepTypes.register(type, handler)` | Register a custom workflow step type (see [Custom Workflow Step Types](#custom-workflow-step-types)) |
| `ctx.stepTypes.get(type)` | Look up a registered step type handler by name |

### Dynamic Items (`ctx.dynamicItems`)

| Method | Description |
| --- | --- |
| `ctx.dynamicItems.register(name, fn)` | Register a dynamic item provider for settings and step type schema enrichment |
| `ctx.dynamicItems.registerDefault(name, fn)` | Register a dynamic default provider (replaces a string property's `default`) |
| `ctx.dynamicItems.invalidate()` | Tell connected clients the provider values changed, so open forms and step dropdowns refetch them |

### State

| Method | Description |
| --- | --- |
| `ctx.isEnabled()` | Check whether this extension is enabled |
| `ctx.isEnabled(name)` | Check whether another extension is enabled |

### Internal (Core Extensions Only)

| Property | Description |
| --- | --- |
| `ctx.internal?.secrets.resolveAs(key, consumer)` | Resolve a secret with a custom consumer identity (e.g. for workflow templates) |

## Configuration

Extensions read config from environment variables following the convention:

```text
EXT_{EXTENSION_NAME_UPPERCASE}_{KEY}
```

For an extension named `my-extension`:

```env
EXT_MY_EXTENSION_API_TOKEN=abc123
EXT_MY_EXTENSION_POLL_INTERVAL=5000
```

Access values via `ctx.config.get(key)` - values are auto-coerced (`"true"` -> boolean, numeric strings -> number, JSON strings -> parsed objects):

```typescript
async initialize(ctx) {
  const token = ctx.config.get("API_TOKEN");
  if (!token) throw new Error("EXT_MY_EXTENSION_API_TOKEN is required");
}
```

Throwing during `initialize()` places the extension in suspended state with the error recorded. The extension remains visible in the UI and can be re-activated after the issue is resolved.

### Settings Schema

Extensions can declare a `settingsSchema` in their manifest to enable UI-based configuration. The schema is a TypeBox `Type.Object()` that describes all configurable settings:

```typescript
import { Type } from "@sinclair/typebox";
import type { Extension } from "@ext/types";

const extension: Extension = {
  manifest: {
    name: "my-extension",
    version: "1.0.0",
    settingsSchema: Type.Object({
      pollingInterval: Type.Number({
        title: "Polling Interval",
        description: "How often to poll in milliseconds",
        default: 5000,
        minimum: 1000,
      }),
      apiEndpoint: Type.String({
        title: "API Endpoint",
        description: "External service URL",
        minLength: 1,
      }),
      mode: Type.Union([
        Type.Literal("fast"),
        Type.Literal("balanced"),
        Type.Literal("thorough"),
      ], {
        title: "Processing Mode",
        default: "balanced",
      }),
      secretKey: Type.String({
        title: "Secret Key",
        sensitive: true,
        description: "API authentication key (masked in the UI)",
      }),
      instructions: Type.String({
        title: "Custom Instructions",
        description: "Multi-line prompt or instructions (newlines preserved)",
        multiline: true,
        default: "Line one\nLine two",
      }),
    }),
  },

  async initialize(ctx) {
    // Typed access with default - returns number, no cast needed
    const interval = ctx.config.get<number>("POLLING_INTERVAL", 5000);

    // Without default - returns ConfigValue | undefined
    const endpoint = ctx.config.get("API_ENDPOINT");
  },

  async shutdown() {},
};

export default extension;
```

**Config resolution order** (highest precedence first):

1. Environment variable `EXT_{NAME}_{KEY}` - always wins (ops override)
2. Persisted value from SQLite (set via the web UI)
3. `default` from the schema property
4. Caller-provided `defaultValue` argument

**Supported schema types for the UI:**

| TypeBox type | Rendered as |
| --- | --- |
| `Type.String()` | Text input |
| `Type.String()` with `multiline: true` | Textarea (preserves newlines) |
| `Type.Number()` / `Type.Integer()` | Number input (with min/max) |
| `Type.Boolean()` | Toggle switch |
| `Type.Union([Type.Literal(...), ...])` | Select dropdown |
| String with `sensitive: true` | Password input (masked) |

**Schema annotations:**

| Keyword | Purpose |
| --- | --- |
| `title` | Form label (falls back to property key) |
| `description` | Help text beneath the control |
| `default` | Initial value when nothing is persisted |
| `sensitive` | Masks the value in the UI and API responses |
| `multiline` | Renders a resizable textarea instead of a single-line input |
| `minimum` / `maximum` | Number constraints |
| `minLength` / `maxLength` | String length constraints |

**Reacting to settings changes:**

Extensions can subscribe to `settings:changed` events if they need to re-initialize when settings are updated via the UI:

```typescript
async initialize(ctx) {
  ctx.events.on("settings:changed", (event) => {
    ctx.log.info("Settings changed, re-reading config...");
    // Re-read values on next config.get() call (cache is auto-invalidated)
  });
}
```

For most extensions, no explicit subscription is needed - `ctx.config.get()` automatically reads fresh values after a settings change.

**Deriving defaults from the schema:**

When calling `ctx.config.get()` with a fallback value, reference the schema's `default` instead of duplicating the literal. This keeps the single source of truth in the manifest:

```typescript
export const manifest = {
  name: "my-extension",
  version: "1.0.0",
  settingsSchema: Type.Object({
    outputPath: Type.String({
      title: "Output path",
      default: "data/reports/output.xlsx",
    }),
  }),
} satisfies ExtensionManifest;

// In initialize() or any helper that has access to the manifest:
const outputPath = ctx.config.get<string>(
  "OUTPUT_PATH",
  manifest.settingsSchema.properties.outputPath.default,
);
```

If you need the default in a separate file (e.g. route handlers), export the manifest and import it where needed:

```typescript
// routes.ts
import { manifest } from "./index";

const outputPath = ctx.config.get<string>(
  "OUTPUT_PATH",
  manifest.settingsSchema.properties.outputPath.default,
);
```

## Logging

Every extension receives a pre-scoped logger via `ctx.log`. Use it instead of importing the `logging` package directly.

```typescript
let log: import("logging").Logger;

const extension: Extension = {
  manifest: { name: "my-extension", version: "1.0.0" },

  async initialize(ctx) {
    log = ctx.log;
    log.info("Initialized");
  },

  async shutdown() {
    log.info("Shutting down");
  },
};
```

## Registering Tools

Tools extend the agent's capabilities. They follow the `AgentTool` interface from `pi-agent-core` with TypeBox parameter schemas.

```typescript
import { Type } from "@sinclair/typebox";
import type { Extension } from "@ext/types";

const extension: Extension = {
  manifest: { name: "weather", version: "1.0.0" },

  async initialize(ctx) {
    ctx.tools.register({
      name: "get_weather",
      description: "Get current weather for a city",
      parameters: Type.Object({
        city: Type.String({ minLength: 1, description: "City name" }),
      }),
      async execute(_toolCallId, params) {
        const apiKey = ctx.config.get("API_KEY");
        const res = await fetch(
          `https://api.example.com/weather?q=${params.city}&key=${apiKey}`
        );
        const data = await res.json();
        return {
          content: [{ type: "text", text: JSON.stringify(data) }],
        };
      },
    });
  },

  async shutdown() {},
};

export default extension;
```

Tool names must be unique across all extensions and core tools.

## Running Sub-Agents

Extensions that need to run an LLM agent as part of their work use `ctx.agent.run()`. The core handles model selection, API key injection, and shell creation - the extension just provides the prompt and configuration.

```typescript
import type { Extension, QueueJob } from "@ext/types";

interface AnalysisJob { text: string }

const extension: Extension = {
  manifest: { name: "analyzer", version: "1.0.0" },

  async initialize(ctx) {
    ctx.queues.create<AnalysisJob>("work", async (job: QueueJob<AnalysisJob>) => {
      const result = await ctx.agent.run(job, {
        systemPrompt: "Analyze the provided text and summarize key points.",
        tools: ["write_file"],        // tool names - core resolves them
        skills: ["task-list"],         // skill names - core builds the shell
        thinkingLevel: "low",
        sessionId: "session-id",      // session for conversation context
      });

      await job.log(`Analysis complete: ${result.answer.slice(0, 100)}...`);
    });
  },

  async shutdown() {},
};

export default extension;
```

For fire-and-forget agent jobs, use `ctx.agent.enqueue()`:

```typescript
const jobId = await ctx.agent.enqueue("process-message", {
  context: { source: "my-extension", id: "123" },
  sessionId: "session-id",
  intent: "vision", // optional: the session's last message contains images
});
```

## Database Access

Extensions that need persistence use `ctx.db` to access the shared Drizzle instance. Define your own table schema with the `ext_{extensionName}_` prefix:

```typescript
// my-extension/schema.ts
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const myRecords = sqliteTable("ext_my_extension_records", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  createdAt: integer("created_at").notNull(),
});
```

```typescript
// my-extension/index.ts
import type { Extension } from "@ext/types";
import { myRecords } from "./schema";

const extension: Extension = {
  manifest: { name: "my-extension", version: "1.0.0" },

  async initialize(ctx) {
    const db = ctx.db;

    // Query your own tables using full Drizzle API
    const all = db.select().from(myRecords).all();
    db.insert(myRecords).values({ name: "test", createdAt: Date.now() }).run();
  },

  async shutdown() {},
};

export default extension;
```

Table naming convention: `ext_{extensionName}_{tableName}`. This prevents collisions between extensions and core tables.

## Skills

Extensions can bundle agent skills by placing them in a `skills/` subdirectory:

```text
src/extensions/my-extension/
├── index.ts
└── skills/
    └── my-skill/
        ├── SKILL.md          # Skill definition (YAML frontmatter + instructions)
        └── scripts/
            └── my-command.ts  # Shell command registration
```

Skill scripts import utilities from the SDK module:

```typescript
// scripts/my-command.ts
import { createCommand, type SkillScriptContext } from "@ext/sdk";

export async function registerSkill(skillName: string, ctx: SkillScriptContext) {
  const command = createCommand({
    name: "my-command",
    description: "Does something useful",
    subcommands: [
      {
        name: "list",
        description: "List items",
        handler: async () => {
          return { exitCode: 0, stdout: "item1\nitem2", stderr: "" };
        },
      },
    ],
  });

  ctx.registerProgram("my-command", command, skillName);
}
```

The `SkillScriptContext` provides:

| Property | Type | Description |
| --- | --- | --- |
| `ctx.baseUrl` | `string` | Extension route prefix (e.g. `http://localhost:3000/ext/my-extension`) |
| `ctx.serverUrl` | `string` | Server origin without trailing slash |
| `ctx.extensionsDir` | `string` | Absolute path to the built-in extensions directory |
| `ctx.fetch` | `typeof fetch` | Identity-bound fetch confined to the owning extension's routes plus `/api/push` (same rules as `ExtensionContext.fetch`) |
| `ctx.registerProgram` | `(name, callback, skillName) => void` | Registers a shell program in the agent sandbox |

### Using `ctx.registerProgram`

Scripts should use `ctx.registerProgram()` to register their shell commands. This avoids importing `registerProgram` from `@ext/sdk` and makes scripts portable - they work regardless of where the script file lives on disk.

Built-in skill scripts (those co-located with extensions in the source tree) can still import from `@ext/sdk` since path aliases resolve correctly there. However, generated or externally-placed scripts (like those produced by the MCP bridge) must use `ctx.registerProgram()` since `@ext/sdk` won't resolve outside the source tree.

## Dependencies

If your extension depends on another extension loading first, list it in the manifest:

```typescript
manifest: {
  name: "my-extension",
  version: "1.0.0",
  dependencies: ["notifier"],  // "notifier" will initialize before this extension
}
```

Circular dependencies are detected and the affected extensions are excluded from loading.

## Custom Workflow Step Types

Extensions can register custom workflow step types that execute deterministic logic (no LLM) as part of multi-step workflows. This allows extensions to add new node types to the workflow graph.

### Registering a Step Type

Call `ctx.stepTypes.register()` during `initialize()`:

```typescript
import { Type } from "@sinclair/typebox";
import type { Extension, StepTypeHandler, StepExecutionContext } from "@ext/types";

const handler: StepTypeHandler = {
  // Validates the step's config (the fields other than `slug` and `type`).
  schema: Type.Object({
    mode: Type.Union([Type.Literal("create"), Type.Literal("append")]),
    path: Type.String({ minLength: 1 }),
    filename: Type.String({ minLength: 1 }),
  }),
  // Describes the shape of the value `execute` returns. Declare exactly the
  // top-level properties your result object has - the editor uses this for
  // deep `{{steps.<slug>.result.<path>}}` autocomplete and validation.
  outputSchema: Type.Object({
    filePath: Type.String({ description: "Absolute path to the written file." }),
    rowCount: Type.Number({ description: "Number of data rows written." }),
  }),
  label: "Excel Writer",
  icon: "TableIcon", // a StepIconName from the frontend icon registry

  async execute(stepDef: Record<string, unknown>, ctx: StepExecutionContext) {
    // Strip the engine-managed fields (slug, type) and the passthrough
    // outputSchema before reading config values.
    const { slug: _slug, type: _type, outputSchema: _os, ...config } = stepDef;
    const { path, filename } = config as { path: string; filename: string };

    // Resolve template expressions in config fields
    const { resolved: resolvedPath } = await ctx.resolveTemplate(path);

    // Do the work...
    await ctx.jobLog(`Writing to ${resolvedPath}/${filename}`);

    // Return value becomes available as {{steps.<slug>.result}}.
    // Its keys must match the outputSchema above.
    return { filePath: `${resolvedPath}/${filename}`, rowCount: 42 };
  },
};

const extension: Extension = {
  manifest: { name: "excel-writer", version: "1.0.0" },

  async initialize(ctx) {
    ctx.stepTypes.register("excel", handler);
  },

  async shutdown() {},
};

export default extension;
```

### StepTypeHandler Interface

| Field | Type | Description |
| --- | --- | --- |
| `schema` | `TObject` | TypeBox schema for validating the step config (excluding `slug` and `type`) |
| `label` | `string` | Human-readable label shown in the workflow editor dropdown and graph nodes |
| `icon` | `StepIconName?` | Optional icon identifier - one of the `StepIconName` keys in the frontend icon registry (`frontend/src/lib/iconRegistry.ts`), e.g. `"TableIcon"`. NOT an emoji or arbitrary string. Omitting it falls back to a generic gear icon. |
| `inputSchema` | `TSchema?` | Optional TypeBox schema describing the expected input data from the preceding step. Used for automatic validation and agent repair. |
| `outputSchema` | `TSchema?` | Optional TypeBox schema describing the shape of the result this step produces. Serialized to JSON Schema by the registry and surfaced to the editor for deep `{{steps.<slug>.result.<path>}}` autocomplete and path validation. Omitting it has no runtime effect. See [Declaring Output Schemas](#declaring-output-schemas). |
| `selfReference` | `boolean?` | When `true`, a step of this type inside an iterator body may reference its own result (`{{steps.<own-slug>.result...}}`) to read the previous pass's value. The handler must give such references a value on the first pass, when no previous result exists. For example, `set-variables` supplies zero values via `ctx.resolveTemplate(value, { stepResults: { [ctx.stepSlug]: current } })`. The editor offers self-references only for these types, and the validator warns about them for all others. |
| `validateInput` | `(output, stepDef) => StepInputValidation \| Promise<StepInputValidation>` | Optional method for domain-specific input validation beyond what `inputSchema` can express. Takes precedence over `inputSchema` when both are present. |
| `execute` | `(stepDef, ctx) => Promise<unknown>` | The execution logic; receives the full step definition and a scoped context |

> **Icon names:** `icon` must be one of the `StepIconName` values defined in `shared/extensions.ts` (`STEP_ICON_NAMES`), each mapping to a `phosphor-svelte` component in `frontend/src/lib/iconRegistry.ts` (e.g. `"TableIcon"`, `"TerminalWindowIcon"`, `"GlobeIcon"`, `"RobotIcon"`). Using a name outside that set fails the frontend type-check. To add a new icon, add the name to `STEP_ICON_NAMES` and register the matching component.

### Declaring Output Schemas

An **output schema** describes the shape of the value a node produces, so the editor can offer deep property-path autocomplete and non-fatal path validation for `{{steps.<slug>.result.<path>}}` (and `{{trigger.payload.<path>}}`) expressions. Without one, autocomplete stops at `result` / `payload`.

There are two ways an output schema is provided, resolved in this precedence order:

1. **A hand-authored `outputSchema` in the workflow JSON5** (on the trigger or the individual step). This always wins for that node.
2. **The step-type handler's declared `outputSchema`** (the `TSchema?` field on `StepTypeHandler`). Used automatically for any step of that type when the definition does not hand-author one.

If neither is present, the node contributes no output completions.

Regardless of source, the schema reaches the editor as JSON Schema: handler TypeBox schemas are serialized by the registry, and the friendly JSON5 type-hint shorthand is compiled to JSON Schema when the workflow-detail payload is assembled. Both representations produce the same autocomplete behavior.

#### Handler-declared output schemas (recommended for custom step types)

Declare `outputSchema` on your `StepTypeHandler` as a TypeBox schema whose top-level properties are exactly the keys your `execute` returns. This gives every workflow that uses your step type autocomplete and validation for free - no per-workflow authoring required.

```typescript
import { Type } from "@sinclair/typebox";
import type { StepTypeHandler } from "@ext/types";

const handler: StepTypeHandler = {
  schema: Type.Object({ /* config fields */ }),
  outputSchema: Type.Object({
    exitCode: Type.Number({ description: "The command's exit code." }),
    stdout: Type.String({ description: "Standard output from the command." }),
    stderr: Type.String({ description: "Standard error output from the command." }),
  }),
  label: "Sandbox Command",
  async execute(stepDef, ctx) {
    // ...
    return { exitCode, stdout, stderr }; // keys match outputSchema
  },
};
```

Guidance:

- Declare every top-level property your result object has, and none it does not. This keeps completion and validation honest.
- For fields that are only sometimes present, wrap them in `Type.Optional(...)` - they still appear in autocomplete.
- Use `description`, `enum` (`Type.Union([Type.Literal(...)])`), and `default` annotations; the editor surfaces them as dropdown metadata.
- For a terminal step that never returns a result (it throws), declare `Type.Object({})`.
- The `outputSchema` field is passed through the step definition at execution time, so strip it alongside `slug` and `type` when reading config: `const { slug: _s, type: _t, outputSchema: _os, ...config } = stepDef;`.
- Declaring `outputSchema` has **no runtime effect** - it is metadata only. A step whose handler omits it produces the identical result and status.

#### Built-in trigger schemas

Filewatcher and scheduler triggers have built-in output schemas derived from their event payloads. These activate automatically without any configuration:

- **filewatcher**: `{ source, id, slug, filename, event }` (all strings)
- **schedule**: `{ source, id, slug, description, label }` (all strings)

Webhook and manual triggers have no built-in schema since their payload is user-defined.

#### Hand-authored output schemas in workflow definitions

For `agent` and `trigger` nodes (which have no handler to declare a schema), or to override a handler's declared schema for one specific step, add an `outputSchema` field directly to a trigger or step in the JSON5. This uses the friendly **type-hint shorthand**: values are either type-hint strings (terminal) or nested objects (non-terminal). The engine compiles this shorthand to JSON Schema when building the editor payload:

```json5
{
  name: "my-workflow",
  trigger: {
    type: "webhook",
    ref: "github-push",
    // Describes the shape of {{trigger.payload.<path>}}
    outputSchema: {
      action: "string",
      repository: {
        name: "string",
        url: "string",
        owner: { login: "string" }
      },
      sender: { login: "string" }
    }
  },
  steps: {
    "fetch-data": {
      type: "agent",
      prompt: "Fetch data for {{trigger.payload.repository.name}}",
      tools: ["exec"],
      // Describes the shape of {{steps.fetch-data.result.<path>}}
      outputSchema: {
        items: "array",
        count: "number",
        metadata: { source: "string", timestamp: "string" }
      }
    }
  },
  edges: []
}
```

With these schemas, the editor autocomplete will suggest `repository`, `action`, `sender` after typing `{{trigger.payload.`, and `name`, `url`, `owner` after `{{trigger.payload.repository.`.

An explicit `outputSchema` on a trigger overrides the built-in default for that trigger type.

#### Config path autocomplete

The `{{steps.<slug>.config.<path>}}` expressions support deep autocomplete automatically by introspecting the step's actual definition. No separate schema declaration is needed - the editor reads the step's JSON structure directly, including array index navigation (e.g. `sheets.0.columns`).

### Input Validation (Pre-Transition Checks)

When a custom step type receives data from a preceding **agent step**, the agent's output may not conform to the expected structure. By the time `execute()` runs, the preceding agent is done and cannot self-correct.

Input validation solves this by checking the agent's output **before the workflow transitions** to the next step. If validation fails, the engine feeds diagnostics back to the agent as a repair prompt (up to 2 retries). This gives the LLM a chance to fix its output without failing the entire workflow.

#### Using `inputSchema` (structural validation)

For simple structural checks, declare a TypeBox schema. The engine automatically validates the agent's output against it using `Value.Check` and formats `Value.Errors` into repair instructions:

```typescript
import { Type } from "@sinclair/typebox";
import type { StepTypeHandler } from "@ext/types";

const handler: StepTypeHandler = {
  schema: Type.Object({ path: Type.String() }),
  label: "JSON Consumer",
  inputSchema: Type.Array(
    Type.Object({
      name: Type.String(),
      value: Type.Number(),
    }),
    { minItems: 1 }
  ),
  async execute(stepDef, ctx) {
    // By the time we get here, input has already been validated
    // ...
  },
};
```

#### Using `validateInput` (domain-specific validation)

For checks that depend on the step's own configuration (e.g. verifying column keys match, enum literals are correct), implement `validateInput`. It receives the raw output and the target step definition:

```typescript
import type { StepTypeHandler, StepInputValidation } from "@ext/types";

const handler: StepTypeHandler = {
  schema: Type.Object({ columns: Type.Array(Type.Object({ key: Type.String() })) }),
  label: "Data Writer",

  validateInput(output: unknown, stepDef: Record<string, unknown>): StepInputValidation {
    if (typeof output !== "string") {
      return { valid: false, diagnostics: ["Expected a JSON string"] };
    }

    const parsed = JSON.parse(output);
    const expectedKeys = (stepDef as any).columns.map((c: any) => c.key);
    const actualKeys = Object.keys(parsed[0] ?? {});
    const missing = expectedKeys.filter((k: string) => !actualKeys.includes(k));

    if (missing.length > 0) {
      return {
        valid: false,
        diagnostics: [`Missing keys: ${missing.join(", ")}. Expected: ${expectedKeys.join(", ")}`],
      };
    }
    return { valid: true };
  },

  async execute(stepDef, ctx) {
    // ...
  },
};
```

#### How the repair loop works

1. Agent step produces its output
2. Engine looks up the **next** step's handler
3. If the handler has `validateInput` or `inputSchema`, validation runs
4. On failure: diagnostics are sent back to the agent as a repair prompt
5. Repeat up to 2 times
6. If still invalid after retries, the step fails with the diagnostics in the job log

#### `StepInputValidation` interface

```typescript
interface StepInputValidation {
  valid: boolean;
  diagnostics?: string[];  // Fed back to the agent on failure
}
```

When both `validateInput` and `inputSchema` are present, `validateInput` takes precedence (the engine does not run both).

### StepExecutionContext

The `execute` function receives a `StepExecutionContext` (not the full `ExtensionContext`):

| Property/Method | Description |
| --- | --- |
| `ctx.resolveTemplate(template)` | Resolve `{{...}}` expressions (trigger payload, step results, step configs, env, secrets) |
| `ctx.log` | Logger instance |
| `ctx.workDir` | Absolute path to the agent's work directory |
| `ctx.jobLog(message)` | Write to the job's persistent log (visible in the web UI) |

### Template Expressions Available

Custom steps have access to the same template engine as built-in steps:

| Expression | Description |
| --- | --- |
| `{{trigger.payload}}` | The workflow's trigger data (full object) |
| `{{trigger.payload.<path>}}` | Dot-path into the trigger payload (e.g. `trigger.payload.filename`) |
| `{{steps.<slug>.result}}` | Result from a completed earlier step |
| `{{steps.<slug>.result.<path>}}` | Dot-path into a step result |
| `{{steps.<slug>.config}}` | Static config of any step in the workflow (including later steps) |
| `{{steps.<slug>.config.<path>}}` | Dot-path into a step's config (supports array indices, e.g. `config.sheets.0.columns`) |
| `{{env.<VAR>}}` | Allowlisted environment variable |
| `{{secret.<KEY>}}` | Encrypted secret (ACL-checked) |

The `config` accessor is particularly useful for schema propagation: an agent step can reference a downstream step's column definitions to know what JSON structure to produce.

### Using Custom Steps in Workflows

Workflow JSON5 definitions use the registered type name directly:

```json5
{
  name: "scan-to-excel",
  trigger: { type: "filewatcher", ref: "inbox-scans" },
  steps: {
    "extract": {
      type: "agent",
      prompt: [
        "Extract data from the document.",
        "Output must match: {{steps.append-row.config.sheets.0.columns}}",
        "Return ONLY a JSON array."
      ],
      tools: ["exec"],
      skills: ["converter"]
    },
    "append-row": {
      type: "excel",
      mode: "append",
      path: "data/reports",
      filename: "documents.xlsx",
      sheets: [{
        name: "Scans",
        columns: [
          { header: "Date", key: "date" },
          { header: "Vendor", key: "vendor" },
          { header: "Amount", key: "amount", numFmt: "#,##0.00" }
        ],
        data: "{{steps.extract.result}}"
      }]
    }
  },
  edges: [
    { from: "extract", to: "append-row" }
  ]
}
```

### Frontend Rendering

Registered step types automatically appear in:

- The step type dropdown in the workflow editor
- Graph nodes with the registered label and icon
- The read-only type badge in the step sidebar

When a step type declares a `schema`, the workflow editor renders a **schema-driven configuration form** instead of a raw JSON textarea. Each schema property becomes a form field with appropriate controls (text inputs, textareas, toggles, dropdowns, multiselects). Users can toggle between the form editor and raw JSON at any time via the "Edit as JSON" / "Use form editor" links.

#### Schema Annotations for Form Rendering

The form renderer uses TypeBox annotations on schema properties to determine labels, descriptions, and input types:

| Annotation | Purpose | Example |
| --- | --- | --- |
| `title` | Form field label (falls back to capitalized property key) | `title: "Output Path"` |
| `description` | Shown as an (i) tooltip icon next to the label | `description: "Relative path to the output directory"` |
| `default` | Pre-populated value for new steps | `default: true` |
| `multiline` | Renders a textarea instead of a single-line input (strings only) | `multiline: true` |
| `minimum` / `maximum` | Number input constraints | `minimum: 1` |
| `minLength` / `maxLength` | String length constraints | `minLength: 1` |
| `dynamicItems` | Names a provider that populates available items at runtime (arrays only) | `dynamicItems: "all-skill-names"` |

**Supported property types:**

| TypeBox type | Rendered as |
| --- | --- |
| `Type.String()` | Text input |
| `Type.String()` with `multiline: true` | Textarea (with template autocomplete) |
| `Type.Boolean()` | Toggle switch |
| `Type.Number()` / `Type.Integer()` | Number input |
| `Type.Union([Type.Literal(...), ...])` | Select dropdown |
| `Type.Array(Type.String())` | Comma-separated text input ("tags") |
| `Type.Array(Type.String())` with `dynamicItems` or `availableItems` | Multiselect |
| Complex types (objects, arrays of objects) | Not supported in form — user is directed to JSON editor |

**Template autocomplete** is automatically enabled on text and textarea fields. Typing `{{` opens a suggestion popup with available template expressions (trigger payload, step results, secrets, env vars).

#### Example with Annotations

```typescript
import { Type } from "@sinclair/typebox";

const handler: StepTypeHandler = {
  schema: Type.Object({
    command: Type.String({
      title: "Command",
      multiline: true,
      minLength: 1,
      description: "Shell command to execute. Supports {{template}} expressions.",
    }),
    skills: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        title: "Skills",
        description: "Skills to mount in the sandbox.",
        dynamicItems: "all-skill-names",
      }),
    ),
    failOnNonZero: Type.Optional(
      Type.Boolean({
        title: "Fail on Non-Zero Exit",
        description: "Throw an error if the command exits with a non-zero code.",
        default: true,
      }),
    ),
  }),
  label: "Sandbox Command",
  icon: "TerminalWindowIcon", // a StepIconName from the frontend icon registry
  async execute(stepDef, ctx) { /* ... */ },
};
```

This renders as: a multiline textarea for the command (with template autocomplete), a multiselect for skills (populated from the `"all-skill-names"` provider), and a toggle for the fail flag (defaulting to on).

#### Dynamic Items for Step Type Schemas

Step type config schemas support the same `dynamicItems` mechanism as extension settings schemas. When the API serves step type metadata to the frontend, each schema property with a `dynamicItems` annotation is enriched with the provider's current values in `availableItems`.

To register a provider, use `ctx.dynamicItems.register()` during `initialize()`:

```typescript
async initialize(ctx) {
  // Make skill names available for multiselect fields
  ctx.dynamicItems.register("all-skill-names", () => ctx.skills.names());

  ctx.stepTypes.register("sandbox-exec", handler);
}
```

Any step type (from any extension) can reference this provider in its schema. Providers are global — one extension can register a provider that another extension's step type schema references.

Providers are evaluated when the frontend fetches the extension list, so a dropdown that is already open in the workflow editor does not notice when the underlying data changes. Call `ctx.dynamicItems.invalidate()` after such a change; connected clients then refetch and show the current options. The `datatables` extension does this when a table is created or deleted:

```typescript
const store = new DataTableStore(ctx.db, {
  onChange: (event) => {
    if (event.created || event.deleted) ctx.dynamicItems.invalidate();
  },
});
```

### Step Type Error Handling

If the extension providing a step type is disabled or unloaded, workflows using that type will fail with a clear error logged to the job:

```text
Step type "excel" is not available. The extension providing this step type may be disabled or not installed.
```

### Constraints

- Step type names must be globally unique (one extension per type)
- Built-in types (`agent`) cannot be overridden
- Step type names follow the same pattern as extension names: `^[a-z][a-z0-9-]*$`
- Disabling the providing extension makes the step type unavailable at runtime (workflows fail explicitly)

## Extension UI

Extensions can add pages to the web UI: full Svelte 5 pages that render inside the app shell, use the same components and theme as core pages, and talk to the extension's own routes. Extensions ship plain `.svelte` sources; Palim compiles them when the extension activates, so no frontend toolchain is needed (this also works for extensions written by the agent).

### Sidebar Navigation

`manifest.ui.navigation` adds sidebar entries (at most 10):

| Field | Description |
| --- | --- |
| `label` | Sidebar text (1-50 characters) |
| `route` | App route, e.g. `/ext-page/<extension>/<page>` for an extension page |
| `icon` | Icon name from the frontend icon registry (`frontend/src/lib/iconRegistry.ts`), e.g. `EnvelopeIcon` |
| `order` | Position (0-999, ascending) |
| `iconColor` | Optional Tailwind classes for the icon, e.g. `text-violet-600 dark:text-violet-500` |
| `badgeKey` | Optional badge source; only keys known to the frontend badge registry show a count |

Navigation routes under `/ext-page/` must point at the extension's own pages: `/ext-page/<other-extension>/...` or an undeclared page id is rejected at load time.

### Svelte Pages

Declare pages in `manifest.ui.pages` (at most 10) and put their sources under `ui/`:

```ts
const manifest = {
  name: "imap-fetch",
  version: "1.0.0",
  ui: {
    pages: [{ id: "accounts", title: "Mail accounts", entry: "ui/AccountsPage.svelte" }],
    navigation: [{ label: "Mail accounts", route: "/ext-page/imap-fetch/accounts", icon: "EnvelopeIcon", order: 60 }],
  },
} satisfies ExtensionManifest;
```

```text
imap-fetch/
├── index.ts
└── ui/
    ├── AccountsPage.svelte      # page entry (declared in the manifest)
    ├── ConnectWizard.svelte     # any number of child components
    ├── counter.svelte.ts        # runes modules (.svelte.ts / .svelte.js) work
    └── types.ts
```

| Field | Description |
| --- | --- |
| `id` | Page id, unique within the extension (`^[a-z0-9][a-z0-9-]*$`) |
| `title` | Page title, shown in the header when no navigation entry matches |
| `entry` | The page component, a `.svelte` file under `ui/` |

A page is rendered at `/ext-page/<extension>/<id>`; `/ext-page/<extension>` shows the first page. Deeper paths (`/ext-page/<extension>/<id>/some/sub/path`) render the same page and expose the sub-path for in-page routing.

The page component receives the host API as its `palim` prop:

```svelte
<script lang="ts">
  import type { PalimHost } from "@ext/ui";
  import { Button, Card, CardContent, CardHeader, CardTitle } from "@palim/ui";
  import { onMount } from "svelte";

  let { palim }: { palim: PalimHost } = $props();

  let accounts: { name: string }[] = $state([]);

  onMount(async () => {
    accounts = (await palim.json<{ accounts: { name: string }[] }>("/accounts")).accounts;
  });

  async function remove(name: string) {
    if (!(await palim.confirm({ title: `Remove “${name}”?`, message: "This cannot be undone.", destructive: true }))) return;
    await palim.json(`/accounts/${encodeURIComponent(name)}`, { method: "DELETE" });
    palim.notify(`Removed “${name}”.`, "success");
  }
</script>

<Card>
  <CardHeader><CardTitle>Accounts</CardTitle></CardHeader>
  <CardContent class="space-y-2">
    {#each accounts as account (account.name)}
      <div class="flex items-center justify-between">
        {account.name}
        <Button variant="outline" size="xs" onclick={() => remove(account.name)}>Remove</Button>
      </div>
    {/each}
  </CardContent>
</Card>
```

### The `palim` Host API

Pages run with their own Svelte runtime, so they cannot share stores or context with the app. Everything a page needs from the app goes through `palim` (types in `shared/extensionUi.ts`, importable as `@ext/ui`):

| Member | Description |
| --- | --- |
| `extension` | `{ name, version }` of the owning extension |
| `page` | `{ id, path, query }`: page id, sub-path below the page route, and query. Also a Svelte store: `$page` updates on in-page navigation |
| `fetch(path, init?)` | Authenticated fetch. `/api/...` and `/ext/...` are used as is; other paths are relative to the extension's routes (`"/accounts"` → `/ext/<name>/accounts`). A 401 logs the user out |
| `json<T>(path, init?)` | Like `fetch`, but `init.body` is JSON-encoded, the response is parsed, and a non-2xx status throws an `Error` with the response's `error` message |
| `onEvent(handler)` | Receives events sent with `ctx.ui.emit()`; returns an unsubscribe function |
| `theme` | `{ dark }`; also a Svelte store: `$theme` is `true` in dark mode |
| `user` | `{ username, displayName, can(action, subject) }` for UI gating (the server enforces) |
| `navigate(path)` | Navigate the app, e.g. to `/workflows` or a sub-path of this page |
| `notify(message, kind?)` | Transient notification (`"info"`, `"success"`, `"error"`) |
| `confirm(options)` | Host confirm dialog: `{ title, message, confirmLabel?, destructive? }` → `Promise<boolean>` |

Host state is exposed as stores rather than runes because runes do not cross Svelte runtimes:

```svelte
<script lang="ts">
  let { palim }: { palim: PalimHost } = $props();
  const page = palim.page;
</script>

{#if $page.path === ""}
  <AccountList {palim} />
{:else}
  <AccountDetail {palim} name={$page.path} />
{/if}
```

### UI Kit and Styling

`@palim/ui` (`frontend/src/lib/extensionKit.ts`) exports the core components, compiled into the extension's bundle so pages look exactly like core pages:

- Primitives: `Button`, `Badge`, `Card` (+ `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`), `Checkbox`, `Label`, `Select` (+ parts), `Table` (+ parts), `Dialog`, `AlertDialog`
- Components: `LoadingIndicator`, `ToggleSwitch`, `StatusDot`, `MultiSelect`
- Helpers: `cn` (class merging)

The kit is a public API. Only stateless components are exported. A stateful module (router, stores, WebSocket connection) would be instantiated a second time inside the bundle, so pages use the `palim` host instead.

**Tailwind:** pages can use Tailwind utility classes. The build scans `ui/` and emits the utilities the extension uses against the app's theme tokens (`frontend/src/theme.css`: `bg-background`, `text-muted-foreground`, `border-input`, `text-destructive`, ...), so `dark:` variants and theme colors match the app. Component-scoped `<style>` blocks work too.

**Packages:** besides `svelte` (pinned to Palim's version) and `@palim/ui`, pages may import `phosphor-svelte` (icons, e.g. `phosphor-svelte/lib/StarIcon`), `bits-ui`, `clsx`, `tailwind-merge`, and `tailwind-variants` without installing them. Other packages must be listed in the extension's `package.json`.

### Server Events

Push updates to open pages instead of polling:

```ts
// index.ts
ctx.ui.emit("account-connected", { name: "work-mail" });
```

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  let { palim }: { palim: PalimHost } = $props();
  onMount(() => palim.onEvent((event, data) => {
    if (event === "account-connected") reload();
  }));
</script>
```

Events go to every connected client. Send identifiers and let the page fetch details through the extension's (authenticated) routes.

### Build, Caching, and Hot Reload

- Pages are compiled when the extension activates (boot, enable, hot load) with `Bun.build`, the Svelte compiler, and Tailwind. Output goes to `<DATA_DIR>/ext-ui/<extension>/<hash>/` and is served publicly from `/ext-ui/...` with immutable caching.
- The hash covers the extension's `ui/` sources, its page declarations, and Palim's UI kit and build pipeline. Unchanged extensions are not rebuilt across restarts; older builds are removed.
- For external extensions, saving a file under `ui/` rebuilds the pages and remounts open pages within about a second, without reloading the extension. Built-in extensions rebuild on restart.
- Build errors do not fail activation: the page shows the error with file, line, and column, and the server logs it.

### Page Rules

- Entries must be `.svelte` files under `ui/`.
- Frontend internals (`$lib/*`) cannot be imported; the build fails with an explanatory error. Use `@palim/ui` and `palim`.
- UI bundles are public static files. They must not contain secrets; data belongs behind the extension's authenticated `/ext/<name>/` routes.
- Pages run in the app's document with the user's session, like core pages. Extensions are trusted code (they already run in-process on the server).

## Lifecycle Summary

1. Registry scans `src/extensions/*/index.ts` and `src/extensions/core/*/index.ts`
2. Validates each module's manifest and interface
3. Resolves dependency order (topological sort)
4. For each extension in order:
   - If disabled in the database: added to the registry as **suspended** (no `initialize()` call)
   - If enabled: `initialize(context)` is called; on failure the extension is suspended with the error recorded
5. On shutdown (SIGINT/SIGTERM), calls `shutdown()` in reverse order
6. Cleans up all registered tools, routes, queues, and event subscriptions

### Enable / Disable (Runtime)

Toggling an extension via the UI or `PUT /api/extensions/:name` triggers a full lifecycle transition:

- **Disable**: calls `shutdown()`, tears down all registrations (tools, routes, queues, events), extension enters suspended state. Takes effect immediately.
- **Enable**: creates a fresh `ExtensionContext`, calls `initialize()`. If initialization fails (e.g. missing credentials), the extension remains suspended and the error is returned to the caller (HTTP 422).

This means disabling an extension **fully stops** it -- no background polling, no queue processing, no event handling.

### Unload (Extension Removal)

`unloadOne()` deactivates the extension (same as disable) and then removes it from the registry entirely. The extension disappears from the UI and its skills are removed from the skill map.

### Core Extensions

Extensions with `core: true` in their manifest are always enabled and cannot be disabled via the API or UI.
