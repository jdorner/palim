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

For non-manual triggers, the `ref` field must match the slug/ID of the corresponding webhook, schedule, or file watcher.

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
- `case` - multi-way branching; `paths` is an array of branch key strings (optional `default`), branches connected via `branch` edges
- `waitFor` - pauses its own branch until an external signal arrives (blocks only its successors, not the whole run)
- `emit` - broadcasts a signal to workflows waiting on that event (fire-and-forget)
- `fail` - aborts the run with a message (provided by `core-wf-steps`)

`if` and `case` nodes are evaluated inline by the engine rather than dispatched as jobs. See the `workflows` agent skill for detailed control-flow examples.

### Signals

Each `waitFor` step that is reached creates a signal record for exactly that step of that run. How it can be resumed:

- **Direct delivery** reaches one specific waiting step: by run and step (`POST /ext/workflows/runs/:runId/steps/:slug/signal`) or by signal ID (`POST /ext/workflows/signals/:signalId`). Steps can hand out their own address with `{{run.id}}`, e.g. as a callback URL in an `http-request` step.
- **`emit`** reaches every waiting step whose event matches, across runs. Narrow it down with:
  - `scope: "instance"` on the `waitFor` - the wait ignores `emit` entirely and only accepts direct delivery
  - `correlate` on both steps - a `waitFor` with a correlation key (e.g. `"{{trigger.payload.orderId}}"`, resolved when the wait is reached) only accepts an `emit` with the same key; a `waitFor` without a key accepts any `emit` of the event
  - `targetRun` on the `emit` - only waits of that run (e.g. `"{{steps.start-child.result.workflowRunId}}"`)

```json5
"await-payment": { "type": "waitFor", "event": "order.paid", "correlate": "{{trigger.payload.orderId}}", "timeout": 86400000 },
// in another workflow:
"payment-done": { "type": "emit", "event": "order.paid", "correlate": "{{trigger.payload.orderId}}", "payload": "{{trigger.payload}}" }
```

The payload is validated against the `waitFor` step's `inputSchema` on every delivery path; an `emit` skips waits whose schema rejects it and logs why. Timeouts survive restarts: pending ones are re-armed at boot, elapsed ones fire immediately.

## Definition Schema

```json5
{
  "name": "my-workflow",           // required, kebab-case
  "description": "What it does.",  // optional
  "trigger": {
    "type": "schedule",            // manual, webhook, schedule, filewatcher
    "ref": "daily-8am"            // required for non-manual triggers
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

## HTTP API

### GET /ext/workflows

List all loaded workflow definitions.

### GET /ext/workflows/:name

Get a single workflow definition, with its resolved `outputSchemas` and `warnings`.

### POST /ext/workflows/meta/analyze

Analyze an unsaved workflow definition (the JSON body) without storing it. Returns `{ valid, outputSchemas, warnings, errors }`, where `outputSchemas` and `warnings` are resolved exactly as for a saved workflow. The editor calls this while you edit, so template autocomplete and template warnings follow the draft instead of the last saved version. A body that is not yet a valid definition still gets best-effort `outputSchemas`; its validation errors are listed in `errors`.

Warnings include references to unknown fields on an iterator's loop variable (`{{item.<field>}}`) when the iterated array's element schema is known.

### GET /ext/workflows/meta/infer-schema/:name

Infer an `outputSchema` shorthand from the newest run of a saved workflow. Query: `source=trigger`, or `source=step&slug=<slug>`. Runs whose sample is missing or not a JSON object (a text payload, an agent's string result) are skipped. Returns `{ runId, runCreatedAt, shorthand }` with the inferred types only, never the sample values. Returns 404 when no run has a usable sample and 400 for an invalid source. The editor's **Infer from last run** button uses this.

### POST /ext/workflows

Create a new workflow definition (writes a JSON5 file).

### PUT /ext/workflows/:name

Update an existing workflow definition.

### DELETE /ext/workflows/:name

Delete a workflow definition (removes the JSON5 file).

### POST /ext/workflows/run/:name

Trigger a manual workflow run. Returns the run ID and per-step job IDs.

### GET /ext/workflows/runs/:runId

Get run status with per-step states.

### GET /ext/workflows/runs/:runId/logs

Get per-step execution logs for a run.

### POST /ext/workflows/runs/:runId/steps/:slug/signal

Deliver a signal to the waiting `waitFor` step `:slug` of a run. The JSON body becomes the step result (validated against the step's `inputSchema` if present). Answers `404` for an unknown run, `409` if the step is not waiting (already delivered, timed out, or the run ended), and `422` for an invalid payload.

### POST /ext/workflows/signals/:signalId

Deliver a signal by its ID (`waitSignalId` of a waiting step in `GET /ext/workflows/runs/:runId`). Same body and status codes as above.

### POST /ext/workflows/runs/:runId/signal/:event

Deliver a signal to the step of a run waiting on `:event`. If several steps of the run wait on the same event, this answers `409` with the candidate `steps`; address one of them with the step route instead.

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

## Hot Reload

The `workflows/` directory is watched for changes. Adding, modifying, or deleting a `.json5` file automatically reloads all definitions without restart.
