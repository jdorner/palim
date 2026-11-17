---

name: workflow-writing
description: How to author workflow JSON5 definitions - schema, graph edges, prompts, template variables, secrets, triggers, and the execution model
---

# Writing Workflows

Detailed authoring reference for workflow JSON5 definitions. For an overview of what workflows are and the CLI commands, read the `workflows` skill first. For each step type's fields, examples, and behavior, run `workflow step-types <type>`.

If the user asks for a new workflow and this chat has not solved the task yet, read `workflow-design` first and follow its steps; use this skill as the reference while you do.

## Workflow authoring checklist

Follow these steps in order when you create or change a workflow.

1. **Discover step types.** Run `workflow step-types` (or `workflow step-types --search "<terms>"`), then `workflow step-types <type>` for every type you use. Do not assume a type exists.
2. **Prefer deterministic steps.** Pick the most deterministic type for each step (see below). Use `agent` only for work that needs an LLM.
3. **Missing capability.** If no step type can do an action the user asked for, say so and ask how to proceed. Never write an `agent` step that is told to use a tool, API or CLI you have not seen in `workflow step-types` or in a skill.
4. **One item at a time.** If a step returns a list and each item needs its own work, write the steps for one item, then wrap them in a loop with `workflow add-loop` (see "Loops" below). Do not put the whole list into one `agent` prompt, unless the step must see all items at once (for example one summary of all).
5. **Structured hand-offs.** Every `agent` step whose result another step uses gets an `outputSchema`.
6. **Trigger ref first.** A `webhook`, `schedule` or `filewatcher` trigger needs its webhook, schedule or watcher to exist before the workflow: `webhook create ...`, `schedule create "<id>" "<name>" -p "0 9 * * *" --tz "Europe/Berlin"`, or the `filewatcher` skill.
7. **Approval.** Ask for permission before you change the system. Show the plan first.
8. **Write as a draft.** A new workflow is always written with `--draft`: `workflow write --draft "<name>" '<json5>'`. If validation fails, fix the reported problem and write again.
9. **Validate.** Run `workflow validate "<name>"` and resolve every warning.
10. **Do not trigger a run without explicit user approval.**

## Design principle: prefer determinism

Use an `agent` step only for open-ended work: summarizing, classifying, free-form extraction, drafting text. Everything else ("convert / fetch / move / transform", "call this API", "branch on a value", "loop over a list") gets a non-agent step type: built-in `http-request`, `set-variables`, `if`, `case`, `iterator`/`aggregator`, `fail`, `emit`, `waitFor`, plus what extensions add (e.g. `convert`, `datatable-*`). A deployment may also have step types that run shell commands or skill programs directly; check `workflow step-types` before defaulting to `agent`.

## JSON5 schema

```json5
{
  // required, kebab-case (^[a-z][a-z0-9-]*$)
  "name": "my-workflow",
  // optional, human-readable
  "description": "What this workflow does.",
  // optional, free-text group that organizes related workflows in the UI list
  // (reuse an existing group name; max 64 chars, no leading/trailing spaces)
  "group": "Finance",
  // required
  "trigger": {
    "type": "manual", // "manual", "webhook", "schedule", "filewatcher", or "portal"
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

### Loops

To handle each item of a list on its own, write the steps for one item first, then run:

```sh
workflow add-loop "<name>" "each-item" --over "{{steps.<slug>.result.<list>}}" --as item --from "<first-body-step>" --to "<last-body-step>"
```

It adds the iterator `each-item` and the aggregator `each-item-done` around the steps from `--from` to `--to`. Inside the loop, read the current item as `{{item}}` or `{{item.<field>}}`, not the whole list. After the loop, read `{{steps.each-item-done.result.results}}`: one entry per item, keyed by the slug of each body step that ran. See the loop example below.

## Changing a workflow

Change an existing workflow with one edit command per change. Each command validates, writes nothing when the result is invalid, and prints the outline and the warnings:

```sh
workflow set-step "<name>" "<slug>" '<json5 of the whole step>' --after "<previous-slug>" [--branch "<path>"]
workflow add-edge "<name>" "<from>" "<to>" [--branch "<path>"]
workflow remove-edge "<name>" "<from>" "<to>" [--branch "<path>"]
workflow remove-step "<name>" "<slug>"
workflow set-meta "<name>" '{ description: "...", trigger: { ... } }'
workflow add-loop "<name>" "<slug>" --over "<list>" [--as "<alias>"] --from "<first>" --to "<last>"
```

- A new step needs `--after`; after an `if`, `case` or `iterator`, also `--branch`.
- `set-step` replaces the whole step: send all its fields.
- For a long prompt, write the step JSON5 to a file with `write_file` and pass `--file "<path>"`.

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
- `{{run.id}}` / `{{run.workflow}}` / `{{run.createdBy}}` - the current run's ID, workflow name, and creator's user ID (e.g. to give an external system a callback address for a `waitFor` step)
- `{{env.VAR_NAME}}` - environment variable value
- `{{secret.SECRET_NAME}}` - encrypted secret (decrypted at access, ACL-checked)

A step can reference the result of ANY completed step, not just its direct predecessor. Results are read from the run store, so `{{steps.<slug>.result}}` resolves for any ancestor in the graph.

### Transform functions

Template expressions support function calls to transform values inline, in addition to plain dot-path lookups. Functions can be nested, and their arguments can be any path lookup or another function call.

```json5
// Strip a data URI prefix, then JSON-escape for safe embedding in a JSON body:
"body": "{\"data\": \"{{ jsonEscape(stripDataUri(image.dataUrl)) }}\"}"
```

There is no pipe/filter syntax: write `join(steps.a.result.list, ", ")`, not `steps.a.result.list | join(", ")`. Bitwise operators (`|`, `&`, `^`, `~`, `<<`, `>>`) are rejected; use `||` and `&&` for logic.

Common functions (the editor's _Available data_ panel lists all of them):

- `jsonEscape(value)`: escape a value for use inside a JSON string literal, e.g. `jsonEscape(steps.extract.result.text)`
- `stripDataUri(value)`: drop a leading `data:<type>;base64,` prefix
- `base64Decode(value)`: base64 to UTF-8 text
- `after(value, delim)` / `before(value, delim)`: the text after / before the first `delim`
- `trim(value)`, `nowIso()`

Notes:

- Functions are pure (string/data/date transforms only) — no I/O, network, filesystem, or secret/env access.
- Hyphenated step slugs work as arguments as written (`trim(steps.fetch-mails.result.subject)`). The slug is matched against the workflow's steps, so the hyphen is not read as a minus sign.
- **JSON bodies:** substituted values are NOT auto-escaped, so wrap anything that might contain a quote or newline in `jsonEscape(...)` — e.g. `"{\"text\": \"{{ jsonEscape(steps.extract.result) }}\"}"`.
- **Security:** `constructor`, `prototype`, `__proto__`, and any `__dunder__` key are refused. Only `trigger`, `steps`, `var`, the iterator alias, and `itemIndex` are reachable; `secret`/`env` are resolved separately and unreachable from function expressions.
- An unknown function or failed evaluation is left literal (`{{...}}`) with a warning — it never throws.

### Accessing secrets

Use `{{secret.<KEY>}}` to inject credentials without hardcoding them (see the prompt example above). The secret is decrypted only at run time, checked against its ACL, and every access is logged. The workflow's identity (`workflow:<name>`) must be listed in the secret's ACL consumers (set in the web UI). If access is denied, the template resolves to an empty string and a warning is logged.

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

The payload is available as `{{trigger.payload}}`. A JSON body is parsed, so fields are reachable directly (`{{trigger.payload.task.id}}`) without converting text to JSON. Declare the body's shape with `outputSchema` on the trigger so these paths validate and autocomplete. Leaves are `"string"`, `"number"`, `"boolean"`, `"object"` (open) or `"any"`; arrays are written `[item]`:

```json5
"trigger": {
  "type": "webhook",
  "ref": "my-webhook-slug",
  "outputSchema": { "task": { "id": "string", "title": "string", "tagIds": ["string"] } }
}
```

The same `outputSchema` field on a step describes its result. On an `http-request` (or other custom) step it replaces the handler's schema, so include `status` and `body`. On an `agent` step it makes the agent answer with a JSON object of that shape, so later steps can read `{{steps.<slug>.result.<field>}}`. Do not ask for JSON in the prompt. A field that may be empty needs the hint `"any"`.

Create the ref first: the workflow does not start while `trigger.ref` matches nothing.

```sh
# Step 1: Create the webhook
webhook create "deploy-trigger" "Deploy Trigger" "none" ""

# Step 2: Create the workflow with matching trigger.ref
workflow write --draft "deploy-pipeline" '{
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

Create the ref first: the workflow does not start while `trigger.ref` matches nothing.

```sh
# Step 1: Create the schedule via the schedule command
schedule create "daily-motd-schedule" "Daily MOTD" -d "Generate and send a daily MOTD" -p "0 9 * * *" --tz "Europe/Berlin"

# Step 2: Create the workflow with matching trigger.ref
workflow write --draft "daily-motd" '{
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

### Portal

Started by a person in the portal (`portal:start` permission), usually by uploading a photo or file. No ref; the optional `portal` object configures the form:

```json5
"trigger": {
  "type": "portal",
  "portal": {
    "title": "Submit a receipt",
    "accept": "image/*,application/pdf",  // default: any file
    "maxSizeMb": 10,                      // default 20, max 50
    "roles": ["uploaders"],               // default: everyone with portal:start
    "fields": { "type": "object", "properties": { "note": { "type": "string", "title": "Note" } } }
  }
}
```

The payload: `{{trigger.payload.file.path}}` (uploaded file, relative to WORK_DIR, e.g. for `convert --file`), `file.name`, `file.mimeType`, `file.size`, `{{trigger.payload.data.<field>}}` (empty optional fields are null), and `{{trigger.payload.submittedBy.username}}`. The run executes as the operator who last saved the workflow in the editor, so a workflow written as a file must be saved once in the editor before the portal can start it.

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

### Loop over a list

One pass per ticket: classify it, label it, then report the count.

```json5
{
  "name": "label-tickets",
  "description": "Classify and label every open ticket",
  "trigger": { "type": "schedule", "ref": "daily-tickets" },
  "steps": {
    "fetch-tickets": {
      "type": "http-request",
      "url": "https://tickets.example.com/api/tickets?state=open",
      "method": "GET",
      "responseFormat": "json",
      "outputSchema": { "status": "number", "body": { "tickets": [{ "id": "string", "title": "string", "text": "string" }] } },
    },
    "each-ticket": { "type": "iterator", "items": "{{steps.fetch-tickets.result.body.tickets}}", "as": "ticket" },
    "classify": {
      "type": "agent",
      "tools": [],
      "prompt": ["Classify this ticket as bug, question or feature.", "Title: {{ticket.title}}", "{{ticket.text}}"],
      "outputSchema": { "category": "string", "reason": "string" },
    },
    "set-label": {
      "type": "http-request",
      "url": "https://tickets.example.com/api/tickets/{{ticket.id}}/labels",
      "body": "{\"label\": \"{{ jsonEscape(steps.classify.result.category) }}\"}",
    },
    "each-ticket-done": { "type": "aggregator", "iterator": "each-ticket" },
    "report": {
      "type": "http-request",
      "url": "https://chat.example.com/hooks/team",
      "body": "{\"text\": \"Labelled {{steps.each-ticket-done.result.totalItems}} tickets.\"}",
    },
  },
  "edges": [
    { "from": "fetch-tickets", "to": "each-ticket" },
    { "from": "each-ticket", "to": "classify", "branch": "each" },
    { "from": "classify", "to": "set-label" },
    { "from": "set-label", "to": "each-ticket-done" },
    { "from": "each-ticket-done", "to": "report" },
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
- A run completes when all terminal steps are completed or dead. A branch without edges (an `if`/`case` path you leave unconnected) just ends the run. All run state is persisted in SQLite and survives restarts.

## Notes

- Step slugs (the `steps` map keys) must match `^[a-z][a-z0-9-]*$`; workflow names must be unique.
- Drafts (`draft: true`) run only by hand until the user activates them in the editor. Disabled workflows (`enabled: false`) are not loaded.
- With no `tools` and no `skills`, the agent runs LLM-only.
- JSON5 allows comments and trailing commas.
- If an `if`/`case` branch has no matching edge, that branch is simply skipped (dead); use a `fail` step to abort with a meaningful error instead.
