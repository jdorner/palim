---
name: workflow-writing
description: How to author workflow JSON5 definitions - schema, graph edges, prompts, template variables, secrets, triggers, and the execution model
---
# Writing Workflows

Detailed authoring reference for workflow JSON5 definitions. For an overview of what workflows are and the CLI commands, read the `workflows` skill first. For each step type's fields and behavior, read the `workflow-step-types` skill (`skill read workflow-step-types`).

## Workflow authoring checklist

When creating or modifying a workflow, be sure to follow these steps meticulously in the order listed.

1. **Discover step types.** Run `workflow step-types` to list what is available in this deployment (built-in plus extension-registered), including each type's config fields. Do not rely on assumptions about what exists
2. **Choose the most deterministic step type per step.** For each step, pick the most deterministic type that does the job (see the determinism principle above). Reserve `agent` steps for work that genuinely needs an LLM
3. **Replace `agent` steps where possible.** For any `agent` step, re-check whether a deterministic type (or a command run in a command-running step type) could do the same work. Prefer it
4. **Ensure the trigger's ref exists.** For a `webhook`, `schedule`, or `filewatcher` trigger, create the referenced webhook/schedule/watcher FIRST - the workflow will not start if `trigger.ref` does not match an existing ref (Manual triggers take no ref.)
5. **Wire the graph.** Define `steps` and `edges`, respecting branch rules for control-flow nodes (`if`/`case`/`iterator`)
6. **Approval.** Always ask for permisson before making any changes to the system. Lay out the implementation plan first
7. **Write.** `workflow write "<name>" '<json5>'`. This validates schema, DAG structure, and custom step-type config. If it fails, fix the reported problem and rewrite - never work around a validation failure
8. **Validate.** `workflow validate "<name>"` and resolve any reported warnings.
9. **Do not trigger a run without explicit user approval**

## Design principle: prefer determinism

**Always** favor predictable, repeatable steps over agent reasoning. Before writing an `agent` step, ask whether the task actually needs an LLM. Use an `agent` step only for genuinely open-ended work (summarizing, classifying, free-form extraction, drafting text). For everything else, use a deterministic step type.

Deciding between the two:

- Deterministic work ("convert / fetch / move / read / write / transform this file", "call this API", "branch on a value", "loop over a list") -> a non-agent step type. Built-in options are `http-request`, `if`, `case`, `iterator`/`aggregator`, `fail`, `emit`, `waitFor`, and extensions may add more.
- Open-ended reasoning -> an `agent` step.

Do not assume the only way to run a command or use a skill is inside an `agent` step. Run `workflow step-types` to see which step types this deployment actually has before defaulting to `agent`; a deployment may provide non-agent step types that run shell commands or skill programs directly.

## JSON5 schema

```json5
{
  // required, kebab-case (^[a-z][a-z0-9-]*$)
  "name": "my-workflow",
  // optional, human-readable
  "description": "What this workflow does.",
  // required
  "trigger": {
    "type": "manual", // "manual", "webhook", "schedule", or "filewatcher"
    "ref": "my-webhook-slug", // required for webhook/schedule/filewatcher
  },
  // optional, defaults to true
  "enabled": true,
  // required: a MAP keyed by slug (at least one step). The slug is the key,
  // it does NOT appear as a field inside the step object.
  "steps": {
    "step-name": {
      "type": "agent", // "agent", "if", "case", "iterator", "aggregator", "waitFor", "emit", or any registered step type
      // optional, tool names for agent steps
      "tools": ["exec"],
      // optional, skill names for agent steps
      "skills": ["task-list"],
      // required for agent steps — string or array of strings
      "prompt": [
        "Line one of the prompt.",
        "Line two of the prompt.",
      ],
    },
    "call-api": {
      "type": "http-request", // outbound HTTP request (registered by core-wf-steps extension)
      "url": "https://example.com", // required
      "method": "POST", // optional, defaults to POST
      "body": "{\"key\": \"value\"}", // optional
    },
  },
  // required: the execution graph. Each edge connects two step slugs.
  "edges": [
    { "from": "step-name", "to": "call-api" },
  ],
}
```

## Steps map and edges

`steps` is a map keyed by slug; the map key is the slug (no `slug` field inside the step). Each edge in `edges` has `from` and `to` (both must reference existing steps) plus an optional `branch` (required only on edges leaving a control-flow node, forbidden otherwise).

### Graph rules (validated at load time)

- Acyclic, with at least one **root** step (no incoming edges); roots are dispatched when the run starts.
- Every step must be reachable from a root (no orphans).
- Non-CF steps must NOT put `branch` on outgoing edges. CF nodes (`if`/`case`/`iterator`) must put a `branch` on every outgoing edge: `if` uses `"then"`/`"else"`, `case` uses the declared `paths` keys, `iterator` uses `"each"`.

### Fan-out and join

A non-CF step with multiple outgoing edges dispatches all successors in parallel. A step with multiple incoming edges is a join: it runs only once every incoming edge is resolved (`satisfied` when the predecessor completed, `dead` when a CF branch was not taken), with at least one `satisfied`.

```json5
"edges": [
  { "from": "extract", "to": "validate" },
  { "from": "extract", "to": "enrich" },   // validate + enrich run concurrently
  { "from": "validate", "to": "combine" },
  { "from": "enrich", "to": "combine" },    // combine waits for BOTH (join barrier)
]
```

## Prompt format

The `prompt` field accepts either a single string or an array of strings. Arrays are joined with newlines at load time. Use arrays for readability:

```json5
// Single string (simple prompts)
"prompt": "Create a short MOTD for a community of builders."

// Array of strings (multi-line prompts, preferred for complex instructions)
"prompt": [
  "First, read the web-access skill to learn how to use the web fetch command:",
  "",
  "skill read web-access",
  "",
  "Then fetch the latest commits from the API:",
  "web fetch -H \"Authorization: Bearer {{secret.GITEA_API_TOKEN}}\" \"https://git.example.com/api/v1/repos/user/repo/commits?limit=10\"",
  "",
  "Return your results in this format:",
  "- sha: <short sha>",
  "  message: <commit message>",
]
```

## Tools and skills per step

Each agent step runs its own isolated agent instance with the tools and skills you assign. Assigning any skill auto-includes `exec` so the agent can run `skill read <name>` to load its instructions; it receives the full skill-aware system prompt, same as the main agent. Any skill can be referenced by name (`webhooks`, `workflows`, `wiki`, etc.).

A skill's registered programs are ordinary sandbox commands. Using a skill therefore does not require an `agent` step: any step type that runs shell commands can mount a skill and call its command directly, which is deterministic and usually preferable to asking an agent to run it. Use `workflow step-types` to see which command-running step types exist in this deployment.

### Available tools

- `exec` - shell commands (includes `filewatcher`, `webhook`, `skill`, `workflow`, etc.)
- `read_file`, `write_file`, `list_files`, `create_directory` - file operations in the work directory
- `send_telegram_message` - send a Telegram message (telegram extension must be enabled)

### How to choose

- "read file X" -> `read_file`; "run command Y" -> `exec`; "manage webhooks" -> `exec` + skill `webhooks`
- Only reasons/summarizes/transforms -> no tools or skills

## Template variables

Use inside `prompt`, `url`, `body`, and control flow `ref`/`match`/`payload` fields:

- `{{trigger.payload}}` - full trigger payload (webhook body, schedule data, file watcher context)
- `{{trigger.payload.field}}` - dot-path into the trigger payload
- `{{trigger.payload.prompt}}` - the schedule's prompt text (schedule triggers only)
- `{{trigger.payload.label}}` - the schedule's human-readable label (schedule triggers only)
- `{{trigger.payload.filename}}` - the detected file path relative to WORK_DIR (file watcher triggers only). For example, if the watcher monitors `inbox` and a file `example.txt` is created, this resolves to `inbox/example.txt`.
- `{{steps.<slug>.result}}` - full result of any completed step
- `{{steps.<slug>.result.field}}` - dot-path into the step's result
- `{{item}}` - current array element (inside an iterator body; name configurable via `as`)
- `{{item.field}}` - dot-path into the current element
- `{{itemIndex}}` - zero-based iteration index (inside an iterator body)
- `{{env.VAR_NAME}}` - environment variable value
- `{{secret.SECRET_NAME}}` - encrypted secret (decrypted at access, ACL-checked)

A step can reference the result of ANY completed step, not just its direct predecessor. Results are read from the run store, so `{{steps.<slug>.result}}` resolves for any ancestor in the graph.

### Transform functions

Template expressions support function calls to transform values inline, in addition to plain dot-path lookups. Functions can be nested, and their arguments can be any path lookup or another function call.

```json5
// Strip a data URI prefix, then JSON-escape for safe embedding in a JSON body:
"body": "{\"data\": \"{{ jsonEscape(stripDataUri(image.dataUrl)) }}\"}"
```

Available built-in functions:

| Function | Description | Example |
|----------|-------------|---------|
| `stripDataUri(value)` | Remove a leading `data:<type>;base64,` prefix, yielding raw base64. Returns the input unchanged if no such prefix is present. | `stripDataUri(image.dataUrl)` |
| `base64Decode(value)` | Decode a base64 string to UTF-8 text. | `base64Decode(steps.fetch.result.body)` |
| `jsonEscape(value)` | Escape a value so it is safe to embed inside a JSON string literal (no surrounding quotes added). Use it whenever you interpolate a value into a JSON `body`. | `jsonEscape(steps.extract.result.text)` |
| `after(value, delimiter)` | Substring after the first occurrence of `delimiter` (empty string if not found). | `after(image.dataUrl, ",")` |
| `before(value, delimiter)` | Substring before the first occurrence of `delimiter` (whole string if not found). | `before(steps.parse.result.pair, "=")` |
| `trim(value)` | Trim leading/trailing whitespace. | `trim(steps.extract.result.name)` |
| `nowIso()` | Current time as an ISO 8601 string. | `nowIso()` |

Notes:

- Functions are pure (string/data/date transforms only) — no I/O, network, filesystem, or secret/env access.
- **JSON bodies:** substituted values are NOT auto-escaped, so wrap anything that might contain a quote or newline in `jsonEscape(...)` — e.g. `"{\"text\": \"{{ jsonEscape(steps.extract.result) }}\"}"`.
- **Security:** `constructor`, `prototype`, `__proto__`, and any `__dunder__` key are refused. Only `trigger`, `steps`, `var`, the iterator alias, and `itemIndex` are reachable; `secret`/`env` are resolved separately and unreachable from function expressions.
- An unknown function or failed evaluation is left literal (`{{...}}`) with a warning — it never throws.

### Accessing secrets

Use `{{secret.<KEY>}}` to inject encrypted credentials into prompts without hardcoding them. The secret is decrypted only at runtime, access is checked against the ACL, and every access attempt is logged.

```json5
{
  "steps": {
    "fetch-commits": {
      "type": "agent",
      "tools": ["exec"],
      "prompt": [
        "Fetch the latest commits from the API:",
        "web fetch -H \"Authorization: Bearer {{secret.GITEA_API_TOKEN}}\" \"https://git.example.com/api/v1/repos/user/repo/commits?limit=10\"",
      ],
    },
  },
  "edges": [],
}
```

The workflow's consumer identity (`workflow:<name>`) must be listed in the secret's ACL consumers (configured via the web UI when storing the secret in the vault). If access is denied, the template resolves to an empty string and a warning is logged.

## Trigger types

### Manual

Triggered via the UI or API (`POST /ext/workflows/run/<name>`).

```json5
"trigger": { "type": "manual" }
```

### Webhook

Triggered when a matching webhook receives a POST request. The webhook emits a `webhook:received` event, and the workflow engine matches `trigger.ref` against the webhook slug.

```json5
"trigger": { "type": "webhook", "ref": "my-webhook-slug" }
```

The payload is available as `{{trigger.payload}}`.

**Atomic creation rule:** When creating a webhook-triggered workflow, always create both the webhook and the workflow together in one operation. The workflow will NOT start if `trigger.ref` doesn't match an existing webhook slug.

```sh
# Step 1: Create the webhook
webhook create "deploy-trigger" "Deploy Trigger" "none" ""

# Step 2: Create the workflow with matching trigger.ref
workflow write "deploy-pipeline" '{
  "name": "deploy-pipeline",
  "description": "Process deployment notifications",
  "trigger": { "type": "webhook", "ref": "deploy-trigger" },
  "steps": {
    "process-deploy": {
      "type": "agent",
      "tools": [],
      "prompt": [
        "A deployment event was received:",
        "{{trigger.payload}}",
        "Summarize what was deployed.",
      ],
    },
  },
  "edges": [],
}'
```

Multiple workflows can listen to the same webhook slug.

### Schedule

Triggered when a matching schedule fires. The scheduler extension emits a `scheduler:fired` event on the event bus, and the workflow engine matches `trigger.ref` against the scheduler ID.

```json5
"trigger": { "type": "schedule", "ref": "my-scheduler-id" }
```

The schedule's prompt and label are available as `{{trigger.payload.prompt}}` and `{{trigger.payload.label}}`.

**Atomic creation rule:** When creating a schedule-triggered workflow, always create both the schedule and the workflow together in one operation. The workflow will NOT start if `trigger.ref` doesn't match an existing scheduler ID.

```sh
# Step 1: Create the schedule via the schedule command
schedule create "daily-motd-schedule" "Daily MOTD" "Generate and send a daily MOTD" "0 9 * * *" "" "Europe/Berlin"

# Step 2: Create the workflow with matching trigger.ref
workflow write "daily-motd" '{
  "name": "daily-motd",
  "description": "Generate and send a daily MOTD",
  "trigger": { "type": "schedule", "ref": "daily-motd-schedule" },
  "steps": {
    "create-motd": {
      "type": "agent",
      "tools": [],
      "prompt": "Create a creative, engaging Message of the Day for a developer community. Keep it short and inspiring.",
    },
    "send-to-telegram": {
      "type": "agent",
      "tools": ["send_telegram_message"],
      "prompt": [
        "Send this MOTD to the default Telegram channel:",
        "{{steps.create-motd.result}}",
      ],
    },
  },
  "edges": [
    { "from": "create-motd", "to": "send-to-telegram" },
  ],
}'
```

Multiple workflows can listen to the same scheduler ID.

### File watcher

Triggered when a matching file watcher detects a new file. The file watcher extension emits a `filewatcher:detected` event, and the workflow engine matches `trigger.ref` against the watcher slug. See the `filewatcher` skill for watcher management.

```json5
"trigger": { "type": "filewatcher", "ref": "inbox-ocr" }
```

The file metadata is available as `{{trigger.payload.filename}}` (path relative to WORK_DIR, e.g. `inbox/example.txt` for a watcher on `inbox`) and `{{trigger.payload.hash}}`.

## Full examples

### Parallel fan-out and join

```json5
{
  "name": "enrich-and-combine",
  "description": "Validate and enrich in parallel, then combine",
  "trigger": { "type": "webhook", "ref": "ingest-hook" },
  "steps": {
    "extract": {
      "type": "agent",
      "tools": ["exec"],
      "prompt": "Extract the record from: {{trigger.payload}}",
    },
    "validate": {
      "type": "agent",
      "tools": [],
      "prompt": "Validate the record: {{steps.extract.result}}",
    },
    "enrich": {
      "type": "agent",
      "tools": ["exec"],
      "prompt": "Enrich the record with external data: {{steps.extract.result}}",
    },
    "combine": {
      "type": "agent",
      "tools": ["write_file"],
      "prompt": [
        "Validation: {{steps.validate.result}}",
        "Enrichment: {{steps.enrich.result}}",
        "Merge and save the final record.",
      ],
    },
  },
  "edges": [
    { "from": "extract", "to": "validate" },
    { "from": "extract", "to": "enrich" },
    { "from": "validate", "to": "combine" },
    { "from": "enrich", "to": "combine" },
  ],
}
```

### Approval gate workflow

```json5
{
  "name": "deploy-with-approval",
  "description": "Deploy after human approval",
  "trigger": { "type": "webhook", "ref": "deploy-request" },
  "steps": {
    "prepare": {
      "type": "agent",
      "tools": ["exec"],
      "prompt": "Prepare the deployment package from: {{trigger.payload}}",
    },
    "await-approval": {
      "type": "waitFor",
      "event": "deploy.approved",
      "timeout": 172800000, // 48 hours
    },
    "deploy": {
      "type": "agent",
      "tools": ["exec"],
      "prompt": [
        "Deployment approved by: {{steps.await-approval.result.approver}}",
        "Execute the deployment.",
      ],
    },
  },
  "edges": [
    { "from": "prepare", "to": "await-approval" },
    { "from": "await-approval", "to": "deploy" },
  ],
}
```

### Conditional notification workflow

```json5
{
  "name": "smart-notify",
  "description": "Route notifications based on severity",
  "trigger": { "type": "webhook", "ref": "alert-hook" },
  "steps": {
    "classify": {
      "type": "agent",
      "tools": [],
      "prompt": [
        "Classify this alert severity as 'critical', 'warning', or 'info':",
        "{{trigger.payload}}",
        "Respond with just the severity level.",
      ],
    },
    "route-severity": {
      "type": "case",
      "match": "{{steps.classify.result}}",
      "paths": ["critical", "warning"],
      "default": "info",
    },
    "notify-oncall": {
      "type": "agent",
      "tools": ["send_telegram_message"],
      "prompt": "CRITICAL ALERT - notify on-call: {{trigger.payload}}",
    },
    "notify-team": {
      "type": "agent",
      "tools": ["send_telegram_message"],
      "prompt": "Warning alert for the team: {{trigger.payload}}",
    },
    "log-info": {
      "type": "agent",
      "tools": ["write_file"],
      "prompt": "Log this info alert to data/alerts.md: {{trigger.payload}}",
    },
  },
  "edges": [
    { "from": "classify", "to": "route-severity" },
    { "from": "route-severity", "to": "notify-oncall", "branch": "critical" },
    { "from": "route-severity", "to": "notify-team", "branch": "warning" },
    { "from": "route-severity", "to": "log-info", "branch": "info" },
  ],
}
```

### Inter-workflow coordination

```json5
// Workflow A: processes data and signals completion
{
  "name": "data-processor",
  "trigger": { "type": "schedule", "ref": "nightly-etl" },
  "steps": {
    "transform": {
      "type": "agent",
      "tools": ["exec", "read_file", "write_file"],
      "prompt": "Run the nightly data transformation pipeline.",
    },
    "signal-done": {
      "type": "emit",
      "event": "etl.complete",
      "payload": "{{steps.transform.result}}",
    },
  },
  "edges": [
    { "from": "transform", "to": "signal-done" },
  ],
}
```

```json5
// Workflow B: waits for data processing to finish before generating report
{
  "name": "report-generator",
  "trigger": { "type": "manual" },
  "steps": {
    "wait-for-data": {
      "type": "waitFor",
      "event": "etl.complete",
      "timeout": 7200000, // 2 hours
    },
    "generate-report": {
      "type": "agent",
      "tools": ["read_file", "write_file"],
      "prompt": [
        "ETL result: {{steps.wait-for-data.result}}",
        "Generate the daily report based on the processed data.",
      ],
    },
  },
  "edges": [
    { "from": "wait-for-data", "to": "generate-report" },
  ],
}
```

## Execution model

- Root steps dispatch in parallel at run start; every other step dispatches once all its incoming edges resolve (`satisfied`/`dead`, at least one `satisfied`). Independent branches run concurrently.
- Control-flow nodes (`if`, `case`, `iterator`) are evaluated inline (not queued) and mark branch edges `satisfied`/`dead`. Dead edges propagate: a step reachable only through dead edges is skipped, and its outgoing edges go dead too.
- Iterator/aggregator pairs iterate sequentially — the aggregator resets and re-dispatches body steps until all items are processed.
- Each step reads any ancestor's result via `{{steps.<slug>.result}}` (resolved from the run store, not just the direct predecessor).
- Fail-fast: any step failure fails the run, cancels in-flight jobs, and marks remaining steps dead.
- `waitFor` releases its worker slot while waiting (blocks only its successors); `emit` is fire-and-forget.
- A run completes when all terminal steps are completed or dead, with at least one completed. All run state is persisted in SQLite and survives restarts.

## Notes

- Workflow names must be unique across all files; step slugs (the `steps` map keys) must match `^[a-z][a-z0-9-]*$`.
- Disabled workflows (`enabled: false`) are skipped during loading.
- With no `tools` and no `skills`, the agent runs LLM-only (no tools).
- JSON5 allows `//` and `/* */` comments and trailing commas — use comments for documentation.
- If an `if`/`case` branch has no matching edge, that branch is simply skipped (dead); use a `fail` step to abort with a meaningful error instead.
- Always ask for approval before triggering a workflow run!
