---
name: workflows
description: Create, modify and query multi-step workflow pipeline JSON5 definitions
---
# Workflow Pipelines

## Overview

Workflows chain multiple agent jobs into sequential pipelines where the output of one step feeds into the next. Definitions are JSON5 files stored in `workflows/`. The system watches this directory and hot-reloads definitions on any change.

## When to use

- When the user wants to create a new multi-step pipeline
- When the user wants to modify, inspect, or delete an existing workflow
- When the user asks about chaining agent tasks, automations, or pipelines

## ⚠️ Duplicate/Similar Workflow Guardrail

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
  // required, at least one step
  "steps": [
    {
      "slug": "step-name", // required, unique within workflow, kebab-case
      "type": "agent", // "agent" or "webhook"
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
    {
      "slug": "call-api",
      "type": "webhook", // outbound HTTP request
      "url": "https://example.com", // required for webhook steps
      "method": "POST", // optional, defaults to POST
      "body": "{\"key\": \"value\"}", // optional
    },
  ],
}
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

Each agent step runs its own isolated agent instance. You can specify both tools and skills per step. When skills are specified, the `exec` tool is automatically included so the agent can read skill instructions.

### Available tools

- `exec` - shell commands (includes `filewatcher`, `webhook`, `skill`, `workflow`, etc.)
- `read_file` - read file contents from the work directory
- `write_file` - write/create files in the work directory
- `list_files` - list directory contents
- `create_directory` - create directories
- `send_telegram_message` - send a Telegram message (telegram extension must be enabled)

### Available skills

Any skill in can be referenced by name: `webhooks`, `workflows`, `wiki`, etc.

When you assign skills to a step, the agent receives the full system prompt with skill context (same as the main agent) and can use `skill read <name>` to load detailed instructions.

### How to choose

- Prompt says "read file X" -> needs `read_file`
- Prompt says "run command Y" -> needs `exec`
- Prompt says "manage webhooks" -> needs `exec` + skill `webhooks`
- Prompt only reasons/summarizes/transforms -> no tools or skills needed

## Template variables

Use inside `prompt`, `url`, and `body` fields:

- `{{trigger.payload}}` - full trigger payload (webhook body, schedule data, file watcher context)
- `{{trigger.payload.field}}` - dot-path into the trigger payload
- `{{trigger.payload.prompt}}` - the schedule's prompt text (schedule triggers only)
- `{{trigger.payload.label}}` - the schedule's human-readable label (schedule triggers only)
- `{{trigger.payload.filename}}` - the detected filename relative to the watched directory, not including the watch path itself (file watcher triggers only). You must prepend the watcher's path to build the full path relative to WORK_DIR (e.g. `inbox/{{trigger.payload.filename}}` for a watcher on `inbox`).
S- `{{steps.<slug>.result}}` - full result of a completed step
- `{{steps.<slug>.result.field}}` - dot-path into the step's result
- `{{env.VAR_NAME}}` - environment variable value
- `{{secret.SECRET_NAME}}` - encrypted secret (decrypted at access, ACL-checked)

### Accessing secrets

Use `{{secret.<KEY>}}` to inject encrypted credentials into prompts without hardcoding them. The secret is decrypted only at runtime, access is checked against the ACL, and every access attempt is logged.

```json5
{
  "steps": [
    {
      "slug": "fetch-commits",
      "type": "agent",
      "tools": ["exec"],
      "prompt": [
        "Fetch the latest commits from the API:",
        "web fetch -H \"Authorization: Bearer {{secret.GITEA_API_TOKEN}}\" \"https://git.example.com/api/v1/repos/user/repo/commits?limit=10\"",
      ],
    },
  ],
}
```

The workflow's consumer identity (`workflow:<name>`) must be listed in the secret's ACL consumers (configured via the web UI when storing the secret in the vault). If access is denied, the template resolves to an empty string and a warning is logged.

## Step types

### Agent step

Runs an LLM prompt. The agent's text response becomes the step result.

```json5
{
  "slug": "extract-data",
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
{
  "slug": "update-tasks",
  "type": "agent",
  "tools": ["exec", "write_file"],
  "skills": ["task-list", "memory-management"],
  "prompt": [
    "Review the current task list and mark completed items.",
    "Update the memory file with a summary of changes.",
  ],
}
```

### Webhook step

Makes an outbound HTTP request. The response body becomes the step result.

```json5
{
  "slug": "notify-slack",
  "type": "webhook",
  "url": "{{env.SLACK_WEBHOOK_URL}}",
  "method": "POST",
  "body": "{\"text\": \"Invoice {{steps.extract-data.result.invoice}} processed.\"}",
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
  "steps": [
    {
      "slug": "process-deploy",
      "type": "agent",
      "tools": [],
      "prompt": [
        "A deployment event was received:",
        "{{trigger.payload}}",
        "Summarize what was deployed.",
      ],
    },
  ],
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
  "steps": [
    {
      "slug": "create-motd",
      "type": "agent",
      "tools": [],
      "prompt": "Create a creative, engaging Message of the Day for a developer community. Keep it short and inspiring.",
    },
    {
      "slug": "send-to-telegram",
      "type": "agent",
      "tools": ["send_telegram_message"],
      "prompt": [
        "Send this MOTD to the default Telegram channel:",
        "{{steps.create-motd.result}}",
      ],
    },
  ],
}'
```

Multiple workflows can listen to the same scheduler ID.

### File watcher

Triggered when a matching file watcher detects a new file. The file watcher extension emits a `filewatcher:detected` event, and the workflow engine matches `trigger.ref` against the watcher slug. See the `filewatcher` skill for watcher management.

```json5
"trigger": { "type": "filewatcher", "ref": "inbox-ocr" }
```

The file metadata is available as `{{trigger.payload.filename}}` (relative to the watched directory, not WORK_DIR — prepend the watcher's path yourself, e.g. `inbox/{{trigger.payload.filename}}`) and `{{trigger.payload.hash}}`.

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
  "steps": [
    {
      "slug": "step-one",
      "type": "agent",
      "tools": [],
      "prompt": "Generate a haiku about coding.",
    },
    {
      "slug": "step-two",
      "type": "agent",
      "tools": [],
      "prompt": ["Translate this haiku to French:", "{{steps.step-one.result}}"],
    },
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

- Steps execute sequentially: step 1 completes -> step 2 starts -> etc.
- Each step receives the previous step's result via `{{steps.<slug>.result}}`
- If any step fails, the workflow fails and remaining steps are skipped
- No retries - a failed step stops the chain
- Each agent step runs in isolation with only the tools and skills you specify

## Notes

- Workflow names must be unique across all JSON5 files
- Step slugs must be unique within a workflow
- Disabled workflows (`enabled: false`) are skipped during loading
- When no `tools` and no `skills` are specified, the agent runs with no tools (LLM-only reasoning)
- When `skills` are specified, `exec` is automatically added to the tool list (even if `tools` is omitted)
- JSON5 supports `//` and `/* */` comments — use them for documentation
- Trailing commas are allowed in arrays and objects
- Always ask for approval before triggeing a workflow run!
