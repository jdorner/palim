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
      "@src/*": ["<relative-path>/src/*"],
      "@shared/*": ["<relative-path>/shared/*"],
      "*": ["./node_modules/*", "<relative-path>/node_modules/*"]
    }
  },
  "include": ["./**/*.ts"],
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

**Restart required:** Dropping a new extension folder into `.palim/extensions/` requires a restart to pick it up. Hot-loading via `loadOne()` is available programmatically but there is no filesystem watcher for new extensions.

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
| `ctx.fetch` | `typeof fetch` | Authenticated fetch - auto-injects `Authorization` for internal URLs, passes through for external |
| `ctx.sessions` | `SessionStorePort` | Shared session store for conversation persistence |

Use `ctx.fetch` instead of the global `fetch()` when calling other extension routes or internal API endpoints. It handles auth transparently:

```typescript
async initialize(ctx) {
  // Call a sibling extension's route (works even when AUTH_TOKEN is set)
  const res = await ctx.fetch("http://localhost:3000/ext/webhooks");
  const webhooks = res.ok ? await res.json() : [];

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
| `ctx.routes.register(method, path, handler)` | Register an HTTP route (auto-prefixed `/ext/{name}/`) |

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

### Agent Execution (`ctx.agent`)

| Method | Description |
| --- | --- |
| `ctx.agent.run(job, opts)` | Run a sub-agent synchronously within a queue job. Core owns model, API key, and shell. |
| `ctx.agent.enqueue(name, data)` | Submit a job to the core Agents queue (fire-and-forget). Returns job ID. |

`ctx.agent.run` is for extensions that process their own queue jobs and need an agent inline. `ctx.agent.enqueue` is for extensions that want to trigger agent work asynchronously.

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
| `ctx.dynamicItems.register(name, fn)` | Register a dynamic item provider for settings schema enrichment |

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

## Custom Workflow Step Types

Extensions can register custom workflow step types that execute deterministic logic (no LLM) as part of multi-step workflows. This allows extensions to add new node types to the workflow graph.

### Registering a Step Type

Call `ctx.stepTypes.register()` during `initialize()`:

```typescript
import { Type } from "@sinclair/typebox";
import type { Extension, StepTypeHandler, StepExecutionContext } from "@ext/types";

const handler: StepTypeHandler = {
  schema: Type.Object({
    mode: Type.Union([Type.Literal("create"), Type.Literal("append")]),
    path: Type.String({ minLength: 1 }),
    filename: Type.String({ minLength: 1 }),
  }),
  label: "Excel Writer",
  icon: "📊",

  async execute(stepDef: Record<string, unknown>, ctx: StepExecutionContext) {
    const { mode, path, filename } = stepDef;

    // Resolve template expressions in config fields
    const { resolved: resolvedPath } = await ctx.resolveTemplate(path as string);

    // Do the work...
    await ctx.jobLog(`Writing to ${resolvedPath}/${filename}`);

    // Return value becomes available as {{steps.<slug>.result}}
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
| `icon` | `string?` | Optional emoji for visual identification in the UI |
| `execute` | `(stepDef, ctx) => Promise<unknown>` | The execution logic; receives the full step definition and a scoped context |

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
| `{{trigger.payload}}` | The workflow's trigger data |
| `{{steps.<slug>.result}}` | Result from a completed earlier step |
| `{{steps.<slug>.config}}` | Static config of any step in the workflow (including later steps) |
| `{{steps.<slug>.config.<path>}}` | Dot-path into a step's config |
| `{{env.<VAR>}}` | Allowlisted environment variable |
| `{{secret.<KEY>}}` | Encrypted secret (ACL-checked) |

The `config` accessor is particularly useful for schema propagation: an agent step can reference a downstream step's column definitions to know what JSON structure to produce.

### Using Custom Steps in Workflows

Workflow JSON5 definitions use the registered type name directly:

```json5
{
  name: "scan-to-excel",
  trigger: { type: "filewatcher", ref: "inbox-scans" },
  steps: [
    {
      slug: "extract",
      type: "agent",
      prompt: [
        "Extract data from the document.",
        "Output must match: {{steps.append-row.config.sheets.0.columns}}",
        "Return ONLY a JSON array."
      ],
      tools: ["exec"],
      skills: ["converter"]
    },
    {
      slug: "append-row",
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
  ]
}
```

### Frontend Rendering

Registered step types automatically appear in:

- The step type dropdown in the workflow editor
- Graph nodes with the registered label and icon
- The read-only type badge in the step sidebar

For custom step types, the editor renders a JSON textarea for the step configuration (fields beyond `slug` and `type`). Structured form editors can be added later.

### Error Handling

If the extension providing a step type is disabled or unloaded, workflows using that type will fail with a clear error logged to the job:

```text
Step type "excel" is not available. The extension providing this step type may be disabled or not installed.
```

### Constraints

- Step type names must be globally unique (one extension per type)
- Built-in types (`agent`, `webhook`) cannot be overridden
- Step type names follow the same pattern as extension names: `^[a-z][a-z0-9-]*$`
- Disabling the providing extension makes the step type unavailable at runtime (workflows fail explicitly)

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
