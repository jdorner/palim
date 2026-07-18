# Writing Extensions

Extensions are self-contained modules that hook into the agent system. Each extension can register tools, HTTP routes, job queues, and agent event subscriptions through the `ExtensionContext` interface.

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

## ExtensionContext API

Every extension receives a scoped `ExtensionContext` during `initialize()`. Here's the full surface:

### Properties

| Property | Type | Description |
| --- | --- | --- |
| `ctx.log` | `Logger` | Pre-scoped logger (`ext:{name}`) |
| `ctx.workDir` | `string` | Absolute path to the agent's work directory |
| `ctx.dataDir` | `string` | Absolute path to the data directory (databases, generated content) |
| `ctx.extensionsDir` | `string` | Absolute path to the extensions directory |
| `ctx.fetch` | `typeof fetch` | Authenticated fetch - auto-injects `Authorization` for internal URLs, passes through for external |

Use `ctx.fetch` instead of the global `fetch()` when calling other extension routes or internal API endpoints. It handles auth transparently — no need to read `AUTH_TOKEN` or construct headers manually:

```typescript
async initialize(ctx) {
  // Call a sibling extension's route (works even when AUTH_TOKEN is set)
  const res = await ctx.fetch("http://localhost:3000/ext/webhooks");
  const webhooks = res.ok ? await res.json() : [];

  // External URLs pass through without modification
  const external = await ctx.fetch("https://api.example.com/data");
}
```

### Registration

| Method | Description |
| --- | --- |
| `ctx.registerTool(tool)` | Register an agent tool (unique name required) |
| `ctx.registerRoute(method, path, handler)` | Register an HTTP route (auto-prefixed `/ext/{name}/`) |
| `ctx.createQueue(name, processor, opts?)` | Create a managed job queue (auto-prefixed `{name}:`) |

### Route Naming Convention

Routes are auto-prefixed with `/ext/{extensionName}/`, so extensions only register the suffix. Use standard REST conventions with the extension name acting as the resource noun:

```text
GET    /ext/{name}           → list all resources
POST   /ext/{name}           → create a resource
GET    /ext/{name}/:id       → get one resource
PUT    /ext/{name}/:id       → update a resource
DELETE /ext/{name}/:id       → delete a resource
```

For extensions managing multiple resource types or needing sub-resources, nest them directly:

```text
GET    /ext/mcp/servers              → list servers
POST   /ext/mcp/servers/:name/sync   → trigger a sync
GET    /ext/scheduler/schedules      → list schedules
POST   /ext/scheduler/schedules      → create a schedule
```

Avoid unnecessary prefixes like `/admin/` — all extension routes are already behind auth.

### Events

| Method | Description |
| --- | --- |
| `ctx.on(type, callback)` | Subscribe to agent lifecycle or domain events on the shared bus |
| `ctx.emitEvent(event)` | Emit a domain event on the shared bus |
| `ctx.broadcast(message)` | Push a WebSocket message to all frontend clients |

### Agent Execution

| Method | Description |
| --- | --- |
| `ctx.runAgent(job, prompt, opts)` | Run a sub-agent synchronously within a queue job. Core owns model, API key, and shell. |
| `ctx.enqueueAgent(name, data)` | Submit a job to the core Agents queue (fire-and-forget). Returns job ID. |

`runAgent` is for extensions that process their own queue jobs and need an agent inline. `enqueueAgent` is for extensions that want to trigger agent work asynchronously.

### Core Queue Access

| Method | Description |
| --- | --- |
| `ctx.onQueueEvent(queueName, event, callback)` | Subscribe to events on a core queue (`"agents"` or `"chat"`) |
| `ctx.getJobLogs(queueName, jobId)` | Read log entries from a core queue job |

### Database

| Method | Description |
| --- | --- |
| `ctx.getDatabase()` | Get the shared Drizzle database instance |

Extensions define their own table schemas with `ext_{extensionName}_` prefixed names. See [Database Access](#database-access) below.

### Introspection

| Method | Description |
| --- | --- |
| `ctx.getConfig(key, default?)` | Read `EXT_{NAME}_{KEY}` env var (auto-coerced) |
| `ctx.getCoreTool(name)` | Retrieve a core tool by name |
| `ctx.getRegisteredTools()` | Get all registered tools (core + extensions) |
| `ctx.getLoadedSkillNames()` | Get names of all loaded skills |
| `ctx.resolveSkill(name)` | Resolve a skill name to its entry |
| `ctx.getFlowProducer()` | Get the shared FlowProducer for job chains |

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

Access values via `ctx.getConfig(key)` - values are auto-coerced (`"true"` -> boolean, numeric strings -> number, JSON strings -> parsed objects):

```typescript
async initialize(ctx) {
  const token = ctx.getConfig("API_TOKEN");
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
    const interval = ctx.getConfig<number>("POLLING_INTERVAL", 5000);

    // Without default - returns ConfigValue | undefined
    const endpoint = ctx.getConfig("API_ENDPOINT");
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
  ctx.on("settings:changed", (event) => {
    ctx.log.info("Settings changed, re-reading config...");
    // Re-read values on next getConfig() call (cache is auto-invalidated)
  });
}
```

For most extensions, no explicit subscription is needed - `getConfig()` automatically reads fresh values after a settings change.

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
    ctx.registerTool({
      name: "get_weather",
      description: "Get current weather for a city",
      parameters: Type.Object({
        city: Type.String({ minLength: 1, description: "City name" }),
      }),
      async execute(_toolCallId, params) {
        const apiKey = ctx.getConfig("API_KEY");
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

Extensions that need to run an LLM agent as part of their work use `ctx.runAgent()`. The core handles model selection, API key injection, and shell creation - the extension just provides the prompt and configuration.

```typescript
import type { Extension, QueueJob } from "@ext/types";

interface AnalysisJob { text: string }

const extension: Extension = {
  manifest: { name: "analyzer", version: "1.0.0" },

  async initialize(ctx) {
    ctx.createQueue<AnalysisJob>("work", async (job: QueueJob<AnalysisJob>) => {
      const result = await ctx.runAgent(job, job.data.text, {
        systemPrompt: "Analyze the provided text and summarize key points.",
        tools: ["write_file"],        // tool names - core resolves them
        skills: ["task-list"],         // skill names - core builds the shell
        thinkingLevel: "low",
      });

      await job.log(`Analysis complete: ${result.answer.slice(0, 100)}...`);
    });
  },

  async shutdown() {},
};

export default extension;
```

For fire-and-forget agent jobs, use `ctx.enqueueAgent()`:

```typescript
const jobId = await ctx.enqueueAgent("process-message", {
  context: { source: "my-extension", id: "123" },
  prompt: "Handle this user request",
});
```

## Database Access

Extensions that need persistence use `ctx.getDatabase()` to get the shared Drizzle instance. Define your own table schema with the `ext_{extensionName}_` prefix:

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
    const db = ctx.getDatabase();

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
| `ctx.fetch` | `typeof fetch` | Authenticated fetch (same as `ExtensionContext.fetch`) |
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
