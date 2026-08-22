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

### Migrating legacy definitions

Older workflows used a sequential `steps` array with inline `then`/`else`/`paths` branches. Convert them in place with:

```bash
bun run migrate-workflows [dir]   # defaults to .work/workflows/
```

The tool skips files already in DAG format and reports a summary of converted, skipped, and errored files.

## HTTP API

### GET /ext/workflows

List all loaded workflow definitions.

### GET /ext/workflows/:name

Get a single workflow definition.

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

### POST /ext/workflows/runs/:runId/signal/:event

Deliver a signal to a run waiting on a `waitFor` step. The JSON body becomes the step result (validated against the step's `inputSchema` if present).

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

## Hot Reload

The `workflows/` directory is watched for changes. Adding, modifying, or deleting a `.json5` file automatically reloads all definitions without restart.
