# Workflows (Core)

The Workflows extension enables multi-step job pipelines defined in JSON5. Steps execute sequentially where the output of one step feeds into the next. Definitions are loaded from the work directory and hot-reloaded on file changes.

This is a core extension and cannot be disabled.

## How It Works

1. Workflow definitions are loaded from `workflows/*.json5` in the work directory
2. The directory is watched for changes and definitions are hot-reloaded automatically
3. Workflows are triggered by events (webhooks, schedules, file watchers) or manually
4. Steps execute sequentially on a dedicated queue via bunqueue's FlowProducer
5. Real-time status updates are pushed to the web UI via WebSocket

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

### Agent Steps

Run an AI agent with a prompt, optional tools, and optional skills:

```json5
{
  "slug": "analyze-data",
  "type": "agent",
  "prompt": "Analyze the incoming data and write a summary.",
  "tools": ["write_file", "exec"],
  "skills": ["wiki"]
}
```

### Webhook Steps

Make an outbound HTTP request:

```json5
{
  "slug": "notify-api",
  "type": "webhook",
  "url": "https://api.example.com/notify",
  "method": "POST",
  "body": "{\"status\": \"complete\"}"
}
```

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
  "steps": [/* ... */]             // required, at least one step
}
```

Definitions are stored as `.json5` files in `workflows/` within the work directory.

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
- `{{steps.<slug>.output}}` - Output from a previous step

## Hot Reload

The `workflows/` directory is watched for changes. Adding, modifying, or deleting a `.json5` file automatically reloads all definitions without restart.
