---
name: filewatcher
description: Manage directory watchers that detect new files and trigger workflows via events
---
# File Watcher Management

## Overview

File watchers monitor directories inside the agent's work directory for new files matching configurable glob patterns. When a matching file is detected, the watcher emits a `filewatcher:detected` event on the event bus. Workflows subscribe to these events via their `trigger.ref` field to start runs automatically.

## When to use

- When the user wants to set up automatic processing of files dropped into a directory
- When the user asks about file watchers, directory monitoring, or file-triggered automations
- When the user wants to list, inspect, create, or remove file watcher registrations

## ⚠️ Strict Operational Constraints

You MUST adhere to these rules to maintain system integrity:

PRIMARY METHOD ONLY: You MUST use the provided filewatcher commands (e.g., `filewatcher create`, `filewatcher delete`, `filewatcher list`) to manage all file watcher state.
FORBIDDEN ACTION: Do NOT attempt to manage file watchers by manually editing configuration files (e.g., `filewatchers.json`) via `exec` (using sed, echo, cat, vi, etc.).
RATIONALE: Manual file manipulation bypasses system validation, risks corrupting JSON structures, and leads to "Split-Brain" scenarios where the agent's perception of the system differs from the actual system state.
VERIFICATION PROTOCOL: After any destructive action (`filewatcher delete`) or modification (`filewatcher update`), you MUST run `filewatcher list` to verify that the system registry reflects your intended changes.
ONLY report success to the user once the verification step confirms the intended state has been reached. If verification fails, report the error and the current state of the system.

## Response Formatting Guidelines

When listing file watchers using `filewatcher list`, ensure you provide a comprehensive overview. This includes:

- The watcher slug/ID
- The human-readable name
- The watched directory path
- The glob patterns being matched
- Whether recursive watching is enabled
- The current status (enabled/disabled)
- **MANDATORY WORKFLOW CROSS-REFERENCE: The `filewatcher list` command only returns watcher metadata. To comply with the "comprehensive overview" requirement, you MUST cross-reference every watcher slug with the available workflows. You must search through the workflow definitions (using `workflow list` or by inspecting workflow files) to identify which workflows are subscribed to the watcher via their `trigger.ref` field. You MUST list these associated workflows in your response.**

## Command reference

### List all file watchers

```sh
filewatcher list
```

Whenever the result is user-facing, present it as a table.

### Get details for a specific file watcher

```sh
filewatcher get "<slug>"
```

### Create a new file watcher

```sh
filewatcher create "<slug>" "<name>" "<path>" "<patterns>" [--recursive] [--process-existing]
```

- `slug`: URL-safe identifier (lowercase, alphanumeric, hyphens). Used as the workflow `trigger.ref`
- `name`: Human-readable label
- `path`: Directory path relative to the work directory (e.g. `inbox`, `data/uploads`)
- `patterns`: Comma-separated glob patterns (e.g. `*.png,*.jpg,*.pdf`)
- `--recursive`, `-r`: Watch subdirectories recursively
- `--process-existing`: Emit events for files already present on start

### Delete a file watcher

```sh
filewatcher delete "<slug>"
```

### Update a file watcher field

```sh
filewatcher update "<slug>" "<field>" "<value>"
```

Updatable fields: `name`, `path`, `patterns`, `recursive`, `processExisting`, `enabled`

- For `patterns`, provide a comma-separated list: `"*.png,*.jpg"`
- For `recursive`, `processExisting`, and `enabled`, use `"true"` or `"false"`

## Examples

### Watch inbox for images (OCR pipeline)

```sh
filewatcher create "inbox-ocr" "OCR Inbox Watcher" "inbox" "*.jpg,*.png"
```

### Watch for PDFs with recursive scanning

```sh
filewatcher create "pdf-scanner" "PDF Scanner" "data/uploads" "*.pdf" --recursive
```

### Process existing files on start

```sh
filewatcher create "backlog-processor" "Backlog Processor" "inbox" "*.txt,*.md" --process-existing
```

### Updating and cleaning up

```sh
filewatcher update "inbox-ocr" "enabled" "false"
filewatcher update "inbox-ocr" "patterns" "*.jpg,*.png,*.webp"
filewatcher delete "old-watcher"
```

## Connecting file watchers to workflows

File watchers emit events - workflows consume them via `trigger.ref`. The watcher slug must match the workflow's `trigger.ref` exactly.

### Example: OCR pipeline triggered by file watcher

```sh
# Step 1: Create the file watcher
filewatcher create "inbox-ocr" "OCR Inbox Watcher" "inbox" "*.jpg,*.png"

# Step 2: Create the workflow with matching trigger.ref
workflow write "ocr-pipeline" "name: ocr-pipeline
description: Process images dropped into inbox
trigger:
  type: filewatcher
  ref: inbox-ocr
steps:
  - slug: scan-image
    type: ocr
    input: inbox/{{trigger.payload.filename}}
    prompt: Extract all text from this image.
"
```

Multiple workflows can listen to the same file watcher slug.

## Notes

- All watched paths are scoped to the agent's work directory for security
- Paths that resolve outside the work directory are rejected
- Registrations are persisted to `filewatchers.json`
- File watchers emit `filewatcher:detected` events with `slug` and `filename` in the context
- Watchers start automatically on boot for enabled registrations
- The `processExisting` flag is useful for catching up on files added while the system was offline
