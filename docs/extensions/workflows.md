# Workflows (Core)

The Workflows extension enables multi-step job pipelines defined in JSON5. A workflow is a directed acyclic graph (DAG): a map of named `steps` plus an `edges` array that wires them together. This supports sequential chains, parallel fan-out, join/convergence barriers, and control flow. Definitions are loaded from the work directory and hot-reloaded on file changes.

This is a core extension and cannot be disabled.

## How It Works

1. Workflow definitions are loaded from `workflows/*.json5` in the work directory
2. The directory is watched for changes and definitions are hot-reloaded automatically
3. Workflows are triggered by events (webhooks, schedules, file watchers) or manually
4. When a run starts, all root steps (no incoming edges) are dispatched in parallel on a dedicated queue
5. A step runs once all its incoming edges are resolved (join barrier); independent branches run concurrently
6. Real-time status updates are pushed to the web UI via WebSocket

## Web UI

The extension registers a **Workflows** page in the sidebar where you can view workflow definitions, trigger runs, and inspect run status with per-step execution logs.

## Trigger Types

| Type | Description | Source |
| --- | --- | --- |
| `manual` | Triggered via API or UI | User action |
| `webhook` | Triggered by an incoming webhook | Webhooks extension |
| `schedule` | Triggered by a cron/interval schedule | Scheduler extension |
| `filewatcher` | Triggered by a file system event | File Watcher extension |
| `portal` | Started by a person in the portal, usually with an uploaded photo or file | [Portal](../portal.md#starting-workflows) |

For webhook, schedule, and file watcher triggers, the `ref` field must match the slug/ID of the corresponding webhook, schedule, or file watcher. Manual and portal triggers take no ref; a portal trigger has a `portal` object instead (title, accepted files, roles, form fields).

## Step Types

Steps are entries in the `steps` map (keyed by slug — the slug is the key, not a field inside the object).

### Agent Steps

Run an AI agent with a prompt, optional tools, and optional skills:

```json5
"analyze-data": {
  "type": "agent",
  "prompt": "Analyze the incoming data and write a summary.",
  "tools": ["write_file", "exec"],
  "skills": ["wiki"]
}
```

### HTTP Request Steps

Make an outbound HTTP request (provided by the `core-wf-steps` extension):

```json5
"notify-api": {
  "type": "http-request",
  "url": "https://api.example.com/notify",
  "method": "POST",
  "body": "{\"status\": \"complete\"}"
}
```

The `http-request` step type supports additional options: custom `headers`, `timeout` (ms), `responseFormat` (`"json"` or `"text"`), and `expectedStatus` (array of acceptable status codes).

### Control Flow Steps

- `if` - conditional branching; branches are expressed as edges with `branch: "then"` / `branch: "else"`
- `case` - multi-way branching; `paths` is an array of branch key strings, branches connected via `branch` edges. When nothing matches, the run takes the branch named by `default` (a path key or a key of its own), or else an edge with `branch: "default"`; without either, the run fails
- `waitFor` - pauses its own branch until an external signal arrives (blocks only its successors, not the whole run)
- `humanTask` - asks a person in the portal and pauses its own branch until they answer (see [Human Tasks](#human-tasks)) - experimental, requires `HITL_ENABLED=true`
- `emit` - broadcasts a signal to workflows waiting on that event (fire-and-forget)
- `fail` - aborts the run with a message (provided by `core-wf-steps`)

`if` and `case` nodes are evaluated inline by the engine rather than dispatched as jobs, so they have no logs. Their step result records the resolved value (`if`: `{ condition, chosenBranch, value }`, `case`: `{ matched, value, fallback }`), and the run page shows the expression, value, and branch taken when you select the node. See the `workflows` agent skill for detailed control-flow examples.

### Human Tasks

A `humanTask` step asks a person: it creates a task in the [portal](../portal.md) (see [the API security model](../api-security-model.md#portal-accounts) for portal accounts) and pauses its branch until someone assigned to it answers. The answer becomes the step result: `outcome` (the chosen button), `data` (form data), `comment`, `respondedBy`, `respondedAt`, `taskId`.

```json5
"review": {
  "type": "humanTask",
  "title": "Approve invoice {{trigger.payload.number}}",
  "body": "Amount: {{steps.extract.result.amount}}",
  "assignees": { "roles": ["accounting"] },
  "outcomes": [{ "id": "approve", "label": "Approve" }, { "id": "reject", "label": "Reject" }],
  "form": { "type": "object", "properties": { "costCenter": { "type": "string" } } },
  "timeout": 172800000,
  "onTimeout": "expire"
}
```

`form` is a JSON Schema object in the subset the portal renders: text, multi-line text (`multiline: true`), date (`format: "date"`), number, integer, boolean, and choices (`enum`, or `anyOf` of `const` + `title`), each with optional `title`, `description`, `default`, plus the `required` list. The editor edits it as a field list; **Edit as JSON** shows the schema, and a schema with other keywords opens as JSON so nothing is lost.

`title`, `body`, `context` values and assignee entries support `{{template}}` expressions. Without `outcomes`, the task offers approve / reject. On timeout the run fails, or with `onTimeout: "expire"` it continues with `outcome: "expired"`. A task cancelled by a manager fails the run, and a run that fails or is deleted cancels its open tasks. The run page shows the waiting task and, with `hitl:manage`, lets you cancel it.

### Signals

Each `waitFor` step that is reached creates a signal record for exactly that step of that run. How it can be resumed:

- **Direct delivery** reaches one specific waiting step: by run and step (`POST /ext/workflows/runs/:runId/steps/:slug/signal`) or by signal ID (`POST /ext/workflows/signals/:signalId`). Steps can hand out their own address with `{{run.id}}`, e.g. as a callback URL in an `http-request` step.
- **`emit`** reaches waiting steps that opt in with `scope: "broadcast"` (the default `instance` scope ignores `emit` entirely) and whose event matches, across runs. Narrow it down with:
  - `correlate` on both steps - a `waitFor` with a correlation key (e.g. `"{{trigger.payload.orderId}}"`, resolved when the wait is reached) only accepts an `emit` with the same key; a `waitFor` without a key accepts any `emit` of the event
  - `targetRun` on the `emit` - only waits of that run (e.g. `"{{steps.start-child.result.workflowRunId}}"`)

```json5
"await-payment": { "type": "waitFor", "event": "order.paid", "scope": "broadcast", "correlate": "{{trigger.payload.orderId}}", "timeout": 86400000 },
// in another workflow:
"payment-done": { "type": "emit", "event": "order.paid", "correlate": "{{trigger.payload.orderId}}", "payload": "{{trigger.payload}}" }
```

The payload is validated against the `waitFor` step's `inputSchema` on every delivery path; an `emit` skips waits whose schema rejects it and logs why. Timeouts survive restarts: pending ones are re-armed at boot, elapsed ones fire immediately.

## Definition Schema

```json5
{
  "name": "my-workflow",           // required, kebab-case
  "description": "What it does.",  // optional
  "group": "Finance",              // optional, organizes the workflow list
  "trigger": {
    "type": "schedule",            // manual, webhook, schedule, filewatcher, portal
    "ref": "daily-8am"            // required for webhook, schedule, filewatcher
  },
  "enabled": true,                 // optional, defaults to true
  "steps": {                       // required: map keyed by slug, at least one step
    "step-a": { "type": "agent", "prompt": "..." },
    "step-b": { "type": "agent", "prompt": "{{steps.step-a.result}}" }
  },
  "edges": [                       // required: the execution graph
    { "from": "step-a", "to": "step-b" }
  ]
}
```

Each edge has `from` and `to` (step slugs) and an optional `branch` (only on edges leaving an `if`/`case` node). At load time the graph is validated for acyclicity, edge-reference integrity, at least one root, full connectivity, and CF-edge rules.

Definitions are stored as `.json5` files in `workflows/` within the work directory.

`group` is free text (1-64 characters, no leading or trailing spaces). The workflow list shows one collapsible section per group, sorted by name, with ungrouped workflows last; the collapsed sections are remembered per browser. While no workflow has a group, the list stays flat. In the editor, the **Group** field next to the description suggests the existing groups.

## HTTP API

### GET /ext/workflows

List all loaded workflow definitions.

### GET /ext/workflows/:name

Get a single workflow definition, with its resolved `outputSchemas` and `warnings`.

### GET /ext/workflows/meta/groups

List the distinct `group` names of all loaded workflows, sorted. The editor uses them as suggestions for the group field.

### POST /ext/workflows/meta/analyze

Analyze an unsaved workflow definition (the JSON body) without storing it. Returns `{ valid, outputSchemas, warnings, errors }`, where `outputSchemas` and `warnings` are resolved exactly as for a saved workflow. The editor calls this while you edit, so template autocomplete and template warnings follow the draft instead of the last saved version. A body that is not yet a valid definition still gets best-effort `outputSchemas`; its validation errors are listed in `errors`.

Warnings include references to unknown fields on an iterator's loop variable (`{{item.<field>}}`) when the iterated array's element schema is known.

### GET /ext/workflows/meta/infer-schema/:name

Infer an `outputSchema` shorthand from the newest run of a saved workflow. Query: `source=trigger`, or `source=step&slug=<slug>`. Runs whose sample is missing or not a JSON object (a text payload, an agent's string result) are skipped. Returns `{ runId, runCreatedAt, shorthand }` with the inferred types only, never the sample values. Returns 404 when no run has a usable sample and 400 for an invalid source. The editor's **Infer from last run** button uses this.

### POST /ext/workflows

Create a new workflow definition (writes a JSON5 file).

### PUT /ext/workflows/:name

Update an existing workflow definition. Saving a workflow with a `portal` trigger binds its portal-started runs to the saving user.

### DELETE /ext/workflows/:name

Delete a workflow definition (removes the JSON5 file).

### POST /ext/workflows/run/:name

Trigger a manual workflow run. Returns the run ID and per-step job IDs.

### GET /ext/workflows/runs/:runId

Get run status with per-step states. `if`/`case` steps carry an `evaluation` (expression, resolved value, branch), and a step that failed without a job (e.g. a `case` with no matching path) carries the failure reason as `error`. A failed run carries `failureReason`. With `?include=results`, each step that produced a result carries it as `result`, but only when the caller started the run (results can hold resolved secrets); everyone else gets statuses only. Meant for API clients; the run page does not request it.

### GET /ext/workflows/runs/:runId/logs

Get per-step execution logs for a run.

### POST /ext/workflows/runs/:runId/steps/:slug/signal

Deliver a signal to the waiting `waitFor` step `:slug` of a run. The JSON body becomes the step result (validated against the step's `inputSchema` if present). Answers `404` for an unknown run, `409` if the step is not waiting (already delivered, timed out, or the run ended), and `422` for an invalid payload.

### POST /ext/workflows/signals/:signalId

Deliver a signal by its ID (`waitSignalId` of a waiting step in `GET /ext/workflows/runs/:runId`). Same body and status codes as above.

### DELETE /ext/workflows/runs/:runId

Cancel all steps of a workflow run.

## Agent Skill

The extension provides a `workflows` skill with sandbox commands:

- `workflow list` - List all workflow definitions
- `workflow read "<name>"` - Read a workflow's JSON5 definition
- `workflow runs "<name>"` - List recent runs for a workflow
- `workflow logs "<run-id>"` - Show per-step logs for a workflow run

## Template Variables

Agent step prompts support template variables:

- `{{trigger.payload}}` - The trigger event payload (webhook body, file path, etc.)
- `{{secret.KEY_NAME}}` - Resolve a secret from the vault
- `{{steps.<slug>.result}}` - Result from any completed step (resolved from the run store, so any ancestor works, not just the direct predecessor)
- `{{run.id}}`, `{{run.workflow}}`, `{{run.createdBy}}` - The current run's ID, workflow name, and creator's user ID
- `{{run.baseUrl}}` - Base URL of the operator UI, without a trailing slash: `WEB_PUBLIC_URL` when set, otherwise the server origin (a wildcard bind address like `0.0.0.0` becomes `localhost`)
- `{{run.url}}` - Link to the current run's page in the operator UI
- `{{env.<VAR>}}` - An allowlisted environment variable, read from the process environment as is. Built-in defaults (e.g. `WEB_SCHEME` = `http`) don't apply, and an unset variable resolves to an empty string with a warning. For links into the UI, use `{{run.baseUrl}}` instead of assembling `{{env.WEB_SCHEME}}://{{env.WEB_HOST}}:{{env.WEB_PORT}}`.

Anything inside `{{...}}` that is not a plain dot-path is evaluated as an expression: arithmetic, comparisons, `?:`, `??`, and function calls, e.g. `{{ steps.vars.result.count + 1 }}` or `{{ trim(trigger.payload.name) }}`. Only the part inside the braces is evaluated: `{{steps.vars.result.count}} + 1` gives `5 + 1`. Hyphens belong to paths, so subtract with spaces (`{{ a - b }}`). Global variables are text, so convert them before calculating: `{{ num(var.counter) + 1 }}`. `secret` and `env` can only be used as plain references, not inside expressions. Built-in functions cover math (`round`, `formatNumber`, ...), text (`upper`, `replace`, `padStart`, ...), lists (`count`, `sum`, `pluck`, `sort`, ...), logic (`if`, `choose`, `isEmpty`, ...), JSON/encoding (`toJson`, `parseJson`, `urlEncode`, ...), and dates (`today`, `formatDate`, `addDays`, `diffDays`, ...; in the time zone `WORKFLOW_TIMEZONE`, else the server's); *Available data* in the editor lists them by category. To update a value (e.g. a counter in an iterator body), use a `set-variables` step with type `number` and a self-reference like `{{ steps.<slug>.result.count + 1 }}`.

To link to another run, combine the base URL with its workflow name and run ID, e.g. `{{run.baseUrl}}/#/workflows/{{trigger.payload.workflow.workflowName}}/runs/{{trigger.payload.workflow.workflowRunId}}`.

In the editor, typing `{{` in a field opens autocomplete (Ctrl+Space reopens it). To browse instead, open **Available data** from the step panel header (or press Ctrl+Shift+Space in a field): a panel beside the step lists the trigger payload, the results of the steps that run before this one, the loop variable inside an iterator, global variables, secrets, env variables, run fields, and functions. Clicking an entry inserts it at the cursor of the field you were editing. Once switched on, the panel stays on (also across reloads), but it only shows while you are editing a field with expression support.

## Hot Reload

The `workflows/` directory is watched for changes. Adding, modifying, or deleting a `.json5` file automatically reloads all definitions without restart.
