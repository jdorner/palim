# File Watcher (Core)

The File Watcher extension manages configurable directory watchers that emit domain events when matching files are detected. These events can trigger workflows, enabling file system changes as automation triggers.

This is a core extension and cannot be disabled.

## How It Works

1. File watcher registrations are persisted in SQLite and loaded on startup
2. Each enabled watcher monitors a directory (optionally recursive) for file events
3. When a file matches the configured glob patterns, a `filewatcher:detected` event is emitted
4. Downstream consumers (e.g. the workflows extension) react to these events

## Web UI

The extension registers a **File Watchers** page in the sidebar where you can create, edit, enable/disable, and delete watchers.

## Configuration

Each file watcher registration has:

| Field | Description |
| --- | --- |
| `slug` | Unique identifier (used as trigger ref in workflows) |
| `name` | Human-readable label |
| `path` | Directory to watch (relative to work directory) |
| `patterns` | Glob patterns to match filenames (e.g. `["*.pdf", "*.jpg"]`) |
| `events` | Which file events to react to: `new`, `change`, `delete` |
| `recursive` | Whether to watch subdirectories |
| `processExisting` | Whether to process files already present on startup |
| `enabled` | Toggle the watcher on/off |

All paths are scoped to the work directory for security.

## HTTP API

### GET /ext/filewatcher/

List all watcher registrations.

### POST /ext/filewatcher/

Create a new watcher.

### PUT /ext/filewatcher/:slug

Update an existing watcher. The watcher is restarted with the new configuration.

### DELETE /ext/filewatcher/:slug

Delete a watcher and stop monitoring.

## Using with Workflows

To trigger a workflow from a file watcher, set the workflow's trigger to:

```json5
{
  "trigger": {
    "type": "filewatcher",
    "ref": "my-watcher-slug"
  }
}
```

The workflow receives the detected file path in the trigger payload.

## Event Payload

The emitted `filewatcher:detected` event contains:

- `slug` - The watcher slug that fired
- `filename` - Relative path of the detected file (within work directory)
- `event` - The event type (`new`, `change`, or `delete`)
