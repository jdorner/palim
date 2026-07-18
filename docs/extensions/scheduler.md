# Scheduler (Core)

The Scheduler extension provides cron and interval-based job scheduling. When a schedule fires, it emits a `scheduler:fired` domain event that downstream consumers (e.g. workflows) can use to trigger work.

This is a core extension and cannot be disabled.

## How It Works

1. Schedules are persisted in bunqueue's SQLite-backed scheduler (survives restarts)
2. When a schedule fires (cron pattern or interval), a job is enqueued on the scheduler queue
3. The job processor emits a `scheduler:fired` event on the shared event bus
4. Downstream consumers (workflows, custom extensions) react to the event

## Web UI

The extension registers a **Schedules** page in the sidebar where you can create, trigger manually, and delete schedules.

## Configuration

Each schedule has:

| Field | Description |
| --- | --- |
| `id` | Unique scheduler identifier (used as trigger ref in workflows) |
| `name` | Human-readable label |
| `description` | What this schedule does |
| `pattern` | Cron expression (e.g. `0 8 * * *` for daily at 8am) |
| `every` | Interval in milliseconds (alternative to cron) |
| `limit` | Maximum number of executions (omit for infinite) |
| `tz` | IANA timezone for cron patterns (e.g. `Europe/Berlin`) |

Provide either `pattern` (cron) or `every` (interval), not both.

## HTTP API

### GET /ext/scheduler/schedules

List all schedules with their configuration and execution state.

### POST /ext/scheduler/schedules

Create a new schedule.

### POST /ext/scheduler/schedules/:id/trigger

Manually fire a schedule. Emits the event directly without counting as a scheduler execution.

### DELETE /ext/scheduler/schedules/:id

Remove a schedule.

## Using with Workflows

To trigger a workflow on a schedule, set the workflow's trigger to:

```json5
{
  "trigger": {
    "type": "schedule",
    "ref": "my-schedule-id"
  }
}
```

## Agent Skill

The extension provides a `scheduler` skill with a `schedule` shell command the agent can use to create, list, and manage schedules from within conversations.

## Cron Syntax

Standard 5-field cron expressions are supported:

```text
minute hour day-of-month month day-of-week
```

Examples:

- `0 8 * * *` - Every day at 8:00
- `*/15 * * * *` - Every 15 minutes
- `0 9 * * 1-5` - Weekdays at 9:00
- `0 0 1 * *` - First day of each month at midnight
