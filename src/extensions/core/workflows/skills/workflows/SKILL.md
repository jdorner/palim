---
name: workflows
description: Create, modify and query multi-step workflow pipeline JSON5 definitions
---
# Workflow Pipelines

## Overview

Workflows chain multiple agent jobs into a directed acyclic graph (DAG) where the output of one step feeds into the next. Definitions are JSON5 files stored in `workflows/`. The system watches this directory and hot-reloads definitions on any change.

A workflow is a set of named `steps` plus an `edges` array that wires them together. This graph model supports:

- **Sequential chains** - edge from one step to the next
- **Parallel fan-out** - a step with multiple outgoing edges dispatches all successors at once
- **Join / convergence** - a step with multiple incoming edges waits until all predecessors resolve before running
- **Control flow** - conditional branching (`if`, `case`), data-driven iteration (`iterator`/`aggregator`), external signal gates (`waitFor`), and cross-workflow signaling (`emit`)

## When to use

- When the user wants to create a new multi-step pipeline
- When the user wants to modify, inspect, or delete an existing workflow
- When the user asks about chaining agent tasks, automations, or pipelines
- When the user needs parallel execution, joins, conditional logic, data-driven loops, approval gates, or inter-workflow coordination

## Duplicate/Similar Workflow Guardrail

**CRITICAL: Before creating a new workflow, you MUST check if a similar workflow already exists. If a user requests a new workflow (e.g., a new schedule or a new webhook trigger) that is highly similar to an existing one (e.g., same purpose, same target like Telegram, similar frequency), you MUST list the existing workflow(s) to the user and ask for clarification on whether they want to modify the existing one or create a new one.**

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

The `steps` field is a map (object) keyed by slug. Each value is the step definition **without** a `slug` field — the map key is the slug.

The `edges` array defines the execution graph. Each edge is an object:

- `from` (required) - source step slug (must exist in `steps`)
- `to` (required) - target step slug (must exist in `steps`)
- `branch` (optional) - required only on edges leaving a control-flow node (`if`/`case`); forbidden on edges from any other step type

### Graph rules (validated at load time)

- The graph must be acyclic (no cycles).
- Every `from`/`to` must reference an existing step.
- There must be at least one **root** step (no incoming edges). Roots are dispatched when the run starts.
- Every step must be reachable from a root (no orphan steps).
- A non-CF step's outgoing edges must NOT have a `branch` property.
- A CF node (`if`/`case`/`iterator`) must have ONLY branch-labeled outgoing edges. For `if`, valid branches are `"then"` and `"else"`. For `case`, branches must match the declared `paths` keys. For `iterator`, the only valid branch is `"each"`.

### Fan-out and join

A non-CF step may have multiple outgoing edges — all of its successors are dispatched in parallel:

```json5
"edges": [
  { "from": "extract", "to": "validate" },
  { "from": "extract", "to": "enrich" },   // validate + enrich run concurrently
  { "from": "validate", "to": "combine" },
  { "from": "enrich", "to": "combine" },    // combine waits for BOTH (join barrier)
]
```

A step with multiple incoming edges is a join: it is dispatched only once all its incoming edges are resolved (either `satisfied` because the predecessor completed, or `dead` because a CF branch was not taken), with at least one `satisfied`.

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

Each agent step runs its own isolated agent instance. You can specify both tools and skills per step. When skills are specified, the `exec` tool is automatically included so the agent can read skill instructions.

### Available tools

- `exec` - shell commands (includes `filewatcher`, `webhook`, `skill`, `workflow`, etc.)
- `read_file` - read file contents from the work directory
- `write_file` - write/create files in the work directory
- `list_files` - list directory contents
- `create_directory` - create directories
- `send_telegram_message` - send a Telegram message (telegram extension must be enabled)

### Available skills

Any skill can be referenced by name: `webhooks`, `workflows`, `wiki`, etc.

When you assign skills to a step, the agent receives the full system prompt with skill context (same as the main agent) and can use `skill read <name>` to load detailed instructions.

### How to choose

- Prompt says "read file X" -> needs `read_file`
- Prompt says "run command Y" -> needs `exec`
- Prompt says "manage webhooks" -> needs `exec` + skill `webhooks`
- Prompt only reasons/summarizes/transforms -> no tools or skills needed

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

- Functions are pure and side-effect-free (string/data/date transforms only). They cannot perform I/O, network, filesystem, or environment/secret access.
- **JSON bodies:** substituted values are NOT auto-escaped, so a value containing a quote or newline can break a JSON `body`. Wrap such values in `jsonEscape(...)` — e.g. `"{\"text\": \"{{ jsonEscape(steps.extract.result) }}\"}"`.
- **Security:** references to `constructor`, `prototype`, `__proto__`, or any `__dunder__` key are refused (left literal with a warning). Only the whitelisted namespaces (`trigger`, `steps`, `var`, the iterator alias, `itemIndex`) and the built-in functions are reachable; `secret`/`env` are resolved separately and are NOT accessible from function expressions.
- If an expression references an unknown function or fails to evaluate, it is left literal (`{{...}}`) and a warning is logged — it never throws.

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

## Step types

### Agent step

Runs an LLM prompt. The agent's text response becomes the step result.

```json5
"extract-data": {
  "type": "agent",
  "tools": ["exec", "read_file"],
  "prompt": [
    "Extract the invoice number and total from:",
    "{{trigger.payload}}",
    "Return as JSON.",
  ],
}
```

Agent step with skills — the agent gets the full skill context and can read skill instructions at runtime:

```json5
"update-tasks": {
  "type": "agent",
  "tools": ["exec", "write_file"],
  "skills": ["task-list", "memory-management"],
  "prompt": [
    "Review the current task list and mark completed items.",
    "Update the memory file with a summary of changes.",
  ],
}
```

### HTTP Request step

Makes an outbound HTTP request. The response body becomes the step result (provided by the `core-wf-steps` extension).

```json5
"notify-slack": {
  "type": "http-request",
  "url": "{{env.SLACK_WEBHOOK_URL}}",
  "method": "POST",
  "body": "{\"text\": \"Invoice {{steps.extract-data.result.invoice}} processed.\"}",
}
```

Additional options: `headers` (an object of key-value string pairs; **omit it entirely if you have no custom headers** — do not set it to an empty string), `timeout` (ms, default 30000), `responseFormat` (`"json"` or `"text"`), `expectedStatus` (array of acceptable status codes). When a `body` is present and no `Content-Type` header is set, `application/json` is applied automatically.

```json5
// With custom headers:
"headers": { "Authorization": "Bearer {{secret.API_TOKEN}}" }
```

### Fail step

Immediately aborts the workflow run with a configurable error message (provided by the `core-wf-steps` extension). Use this on a branch where reaching that path means the workflow cannot continue (e.g. an unexpected `case` branch).

```json5
"abort-unexpected": {
  "type": "fail",
  "message": "Unexpected category: {{steps.classify.result}}",
}
```

The `message` field is optional (defaults to "Workflow aborted by fail step") and supports `{{template}}` expressions. When executed, the step logs the message, throws an error, and the entire run is marked failed (fail-fast).

### If step (conditional branching)

Evaluates a condition against a resolved template value. It is NOT dispatched as a job — the engine evaluates it inline when its incoming edges are satisfied. The `then` and `else` branches are expressed as **edges**, not nested arrays.

```json5
{
  "steps": {
    "extract-data": {
      "type": "agent",
      "tools": ["exec"],
      "prompt": "Extract priority from: {{trigger.payload}}",
    },
    "check-priority": {
      "type": "if",
      "condition": {
        "ref": "{{steps.extract-data.result.priority}}",
        "eq": "high",
      },
    },
    "urgent-notify": {
      "type": "agent",
      "tools": ["send_telegram_message"],
      "prompt": "Send an urgent notification: {{steps.extract-data.result}}",
    },
    "log-low-priority": {
      "type": "agent",
      "tools": ["write_file"],
      "prompt": "Append to the low-priority log: {{steps.extract-data.result}}",
    },
  },
  "edges": [
    { "from": "extract-data", "to": "check-priority" },
    // Branch edges MUST carry a "branch" property on if/case nodes
    { "from": "check-priority", "to": "urgent-notify", "branch": "then" },
    { "from": "check-priority", "to": "log-low-priority", "branch": "else" },
  ],
}
```

If the chosen branch is `then`, the `then` edges become `satisfied` and the `else` edges become `dead` (and vice versa). Dead edges propagate downstream so any step reachable only through a dead branch is skipped.

#### Condition operators

The `condition` object requires a `ref` field (template expression to resolve) and exactly one operator:

| Operator | Description | Example |
|----------|-------------|---------|
| `eq` | String equality after `String()` coercion | `"eq": "success"` |
| `neq` | Logical negation of eq | `"neq": "error"` |
| `gt` | Greater than (numeric if both parseable, otherwise lexicographic) | `"gt": 100` |
| `gte` | Greater than or equal | `"gte": 0` |
| `lt` | Less than | `"lt": 50` |
| `lte` | Less than or equal | `"lte": 1000` |
| `in` | Membership in array (String coercion per element) | `"in": ["draft", "review", "published"]` |
| `contains` | Case-sensitive substring check | `"contains": "error"` |
| `exists` | Not null, not undefined, not empty string | `"exists": true` |
| `matches` | Regex test against String(value) | `"matches": "^\\d{4}-\\d{2}-\\d{2}$"` |

For `null` or `undefined` resolved values, all operators except `exists` return false without performing the comparison.

### Case step (multi-way branching)

Resolves a `match` template and routes to the matching branch. The `paths` field is an **array of branch key strings** (not nested step arrays). Branch steps are separate top-level steps connected via edges whose `branch` matches a path key. An optional `default` names the fallback branch key.

```json5
{
  "steps": {
    "classify": {
      "type": "agent",
      "tools": [],
      "prompt": "Classify the document as 'invoice', 'receipt', or 'other': {{trigger.payload}}",
    },
    "route-by-type": {
      "type": "case",
      "match": "{{steps.classify.result}}",
      "paths": ["invoice", "receipt"],
      "default": "receipt",
    },
    "process-invoice": {
      "type": "agent",
      "tools": ["exec"],
      "prompt": "Process the invoice: {{trigger.payload}}",
    },
    "process-receipt": {
      "type": "agent",
      "tools": ["write_file"],
      "prompt": "Archive the receipt: {{trigger.payload}}",
    },
  },
  "edges": [
    { "from": "classify", "to": "route-by-type" },
    { "from": "route-by-type", "to": "process-invoice", "branch": "invoice" },
    { "from": "route-by-type", "to": "process-receipt", "branch": "receipt" },
  ],
}
```

Path matching is exact and case-sensitive (no trimming). If the resolved value matches no path and no `default` is set, the run fails.

### Iterator + Aggregator (data-driven loop)

Iterates over an array, executing the body steps once per element. Uses two paired nodes: an **iterator** (splits the array, opens the loop scope) and an **aggregator** (collects results, drives re-execution or completes).

The body steps between them are regular top-level nodes — they show up in the graph, get their own status/logs, and can be any step type.

**Iterator definition:**

```json5
"iter": {
  "type": "iterator",
  "items": "{{trigger.payload}}",  // template expression resolving to a JSON array
  "as": "image",                   // optional, variable name for current element (default: "item")
}
```

**Aggregator definition:**

```json5
"collect": {
  "type": "aggregator",
  "iterator": "iter",  // slug of the paired iterator
}
```

**Wiring:** The iterator's outgoing edge must have `branch: "each"`. Body steps connect sequentially between iterator and aggregator with regular (unlabeled) edges.

```json5
"edges": [
  { "from": "iter", "to": "convert", "branch": "each" },
  { "from": "convert", "to": "collect" },
  { "from": "collect", "to": "downstream-step" },
]
```

**Template variables inside the loop body:**

- `{{<as>}}` (e.g. `{{image}}`) — the current array element
- `{{<as>.<field>}}` (e.g. `{{image.dataUrl}}`) — dot-path into the current element
- `{{itemIndex}}` — zero-based iteration index

**Aggregator result:** After all iterations complete, the aggregator's result is available downstream as `{{steps.<aggregator-slug>.result}}` containing `{ results: [...], totalItems, succeeded, failed }`.

**Full example:**

```json5
{
  "name": "process-scans",
  "trigger": { "type": "webhook", "ref": "scan-app" },
  "steps": {
    "iter": {
      "type": "iterator",
      "items": "{{trigger.payload}}",
      "as": "image",
    },
    "ocr": {
      "type": "http-request",
      "url": "http://localhost:3000/ext/converter/convert",
      "method": "POST",
      // The webhook delivers images as data URIs (data:image/...;base64,...),
      // but the converter's `data` field expects raw base64. stripDataUri removes
      // the prefix; jsonEscape keeps the value safe inside the JSON body.
      "body": "{\"data\": \"{{ jsonEscape(stripDataUri(image.dataUrl)) }}\"}",
      "responseFormat": "json",
      "timeout": 120000,
    },
    "collect": {
      "type": "aggregator",
      "iterator": "iter",
    },
    "summarize": {
      "type": "agent",
      "prompt": "Summarize OCR results: {{steps.collect.result.results}}",
    },
  },
  "edges": [
    { "from": "iter", "to": "ocr", "branch": "each" },
    { "from": "ocr", "to": "collect" },
    { "from": "collect", "to": "summarize" },
  ],
}
```

**Rules:**
- Every iterator must have exactly one aggregator referencing it (via the aggregator's `iterator` field)
- The aggregator must be reachable from the iterator's `each` branch
- The iterator's outgoing edges must all carry `branch: "each"` (it is a CF node)
- The aggregator has regular (unlabeled) outgoing edges
- Iteration is sequential — each item runs through the full body before the next starts
- If a body step fails, the entire run fails (fail-fast)

### WaitFor step (signal gate)

Pauses its own branch and releases the worker slot until an external signal is delivered via the API. In the DAG model, `waitFor` is a regular node: it blocks only its own successors — independent branches keep running.

```json5
"await-approval": {
  "type": "waitFor",
  // Signal event name (lowercase, dots/hyphens allowed)
  "event": "approval.granted",
  // Optional timeout in ms (1 second to 7 days). Run fails if exceeded.
  "timeout": 86400000, // 24 hours
  // Optional JSON Schema for validating the incoming signal payload
  "inputSchema": {
    "type": "object",
    "properties": {
      "approver": { "type": "string" },
      "comment": { "type": "string" },
    },
    "required": ["approver"],
  },
}
```

When the signal arrives, its payload becomes the step result. Successor steps access it via `{{steps.await-approval.result}}` or `{{steps.await-approval.result.approver}}`.

#### Delivering a signal

Send a POST request to resume a waiting workflow:

```
POST /ext/workflows/runs/<runId>/signal/<event>
Content-Type: application/json

{ "approver": "joe", "comment": "Looks good" }
```

Response codes:
- `200` - Signal accepted, workflow resumed
- `404` - Run not found
- `409` - Run not waiting for this event, or signal already delivered
- `422` - Payload fails inputSchema validation

#### Event name rules

Event names must match `^[a-z][a-z0-9._-]*$` (max 128 characters). Examples: `approval.granted`, `deploy-ready`, `data.processed`.

### Emit step (cross-workflow signal)

Sends a named signal to all workflows currently waiting for that event. The emitting branch continues immediately (fire-and-forget).

```json5
"notify-ready": {
  "type": "emit",
  // Signal event name to broadcast
  "event": "data.processed",
  // Optional payload template (resolved before emission)
  "payload": "{{steps.transform.result}}",
}
```

Any workflow with a `waitFor` step listening for `"data.processed"` will be resumed with the emitted payload.

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

## Command reference

```sh
workflow list                          # list all workflow definitions
```

Whenever the result is user-facing, present it as a table.

```sh
workflow read "<name>"                 # display full JSON5 content
workflow write "<name>" "<json5>"      # create or overwrite (validates first)
workflow validate "<name>"             # validate against schema
workflow delete "<name>"               # delete a workflow file
workflow trigger "<name>" "<payload>"  # trigger a run (payload optional, use "" if empty)
workflow runs "<name>"                 # list recent runs with status
workflow logs "<run-id>"               # show per-step execution logs
workflow cancel "<run-id>"             # cancel all steps of a running workflow
```

## Creating a workflow

```sh
workflow write "my-pipeline" '{
  "name": "my-pipeline",
  "description": "A simple two-step pipeline",
  "trigger": { "type": "manual" },
  "steps": {
    "step-one": {
      "type": "agent",
      "tools": [],
      "prompt": "Generate a haiku about coding.",
    },
    "step-two": {
      "type": "agent",
      "tools": [],
      "prompt": ["Translate this haiku to French:", "{{steps.step-one.result}}"],
    },
  },
  "edges": [
    { "from": "step-one", "to": "step-two" },
  ],
}'
```

Changes are picked up automatically - no restart needed.

## Modifying a workflow

```sh
workflow read "my-pipeline"
workflow write "my-pipeline" '<updated-json5>'
workflow validate "my-pipeline"
```

## Execution model

- The engine dispatches all root steps (no incoming edges) in parallel when the run starts.
- A step is dispatched only when all its incoming edges are resolved (`satisfied` or `dead`) with at least one `satisfied` (join barrier).
- A non-CF step with multiple outgoing edges fans out — all successors are dispatched.
- Independent branches execute concurrently on the queue.
- Control flow nodes (`if`, `case`, `iterator`) are evaluated inline (not queued) and mark their branch edges `satisfied`/`dead`.
- Dead edges propagate: a step reachable only through dead edges is skipped (marked `dead`), and its outgoing edges become dead too.
- Iterator/aggregator pairs drive sequential iteration: the aggregator resets body steps between iterations and re-dispatches them until all items are processed.
- Each step receives previous step results via `{{steps.<slug>.result}}`, resolved from the run store (any ancestor, not just the direct predecessor).
- Fail-fast: if any step fails, the run fails, in-flight jobs are cancelled, and remaining pending steps are marked dead.
- `waitFor` releases its worker slot while waiting (blocks only its own successors, not the whole run).
- `emit` is fire-and-forget - the emitting branch continues immediately.
- The run is marked completed when all terminal steps (no outgoing edges) are completed or dead, with at least one completed.
- Workflow state (results, edge states, step statuses, run status) is persisted in SQLite and survives restarts.

## Migrating legacy workflows

Older workflows used a sequential `steps` array with inline `then`/`else`/`paths` branches. A CLI tool converts them to the DAG format in place:

```sh
bun run migrate-workflows            # convert .work/workflows/*.json5
bun run migrate-workflows <dir>      # convert a specific directory
```

The tool skips files already in DAG format (steps object + edges array), converts sequential steps into chained edges, flattens `if`/`case` branches into top-level steps with branch edges, and reports a summary. It does not create backups (use version control for rollback).

## Notes

- Workflow names must be unique across all JSON5 files
- Step slugs are the keys of the `steps` map and must match `^[a-z][a-z0-9-]*$`
- The graph must be acyclic, fully connected (every step reachable from a root), and have at least one root
- Disabled workflows (`enabled: false`) are skipped during loading
- When no `tools` and no `skills` are specified, the agent runs with no tools (LLM-only reasoning)
- When `skills` are specified, `exec` is automatically added to the tool list (even if `tools` is omitted)
- JSON5 supports `//` and `/* */` comments — use them for documentation
- Trailing commas are allowed in arrays and objects
- Only edges from `if`/`case`/`iterator` nodes may carry a `branch` property; all other edges must omit it
- If an `if`/`case` branch has no matching edge and no path is taken, the corresponding branch is simply skipped (dead)
- Use a `fail` step on a branch to explicitly abort with a meaningful error message
- Always ask for approval before triggering a workflow run!
