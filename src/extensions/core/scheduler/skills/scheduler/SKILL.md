---
name: scheduler
description: Create and manage cron and interval-based scheduled tasks
---
# Scheduler

## Overview

Schedules fire on a cron pattern or fixed interval. When a schedule fires, it emits a `scheduler:fired` event that workflows can subscribe to via `trigger.type: schedule` with `trigger.ref` matching the schedule ID.

Schedules are persisted in SQLite and survive restarts.

## When to use

- When the user wants to create a recurring task (daily, hourly, etc.)
- When the user wants to list, inspect, or remove existing schedules
- When setting up a schedule-triggered workflow (create the schedule first, then the workflow)
- When the user asks about cron jobs, timers, or recurring automations

## ⚠️ Important

- **Always check the current timezone** via the `date` command before creating cron schedules
- Provide either a `pattern` (cron expression) or `every` (millisecond interval), not both
- The `id` is used as the `trigger.ref` in workflow definitions - choose meaningful, kebab-case IDs
- When creating a schedule for a workflow, create the schedule first, then the workflow with a matching `trigger.ref`
- After any modification or deletion action (`schedule update`, `schedule delete`, `schedule create`), you MUST run `schedule list` (and/or `schedule get <id>` for the specific schedule) to verify that the system registry reflects your intended changes. ONLY report success to the user once the verification step confirms the intended state has been reached. If verification fails, report the error and the current state of the system.

## Command reference

### List all schedules

```sh
schedule list
```

### Get a specific schedule

```sh
schedule get "<id>"
```

### Create a schedule

With a cron pattern:

```sh
schedule create "<id>" "<name>" --pattern "0 9 * * *"
```

With a cron pattern, timezone, and description:

```sh
schedule create "<id>" "<name>" -d "What this does" -p "0 9 * * *" --tz "Europe/Berlin"
```

With a millisecond interval (minimum 1000ms):

```sh
schedule create "<id>" "<name>" --every 300000
```

With an execution limit:

```sh
schedule create "<id>" "<name>" -p "0 9 * * *" --limit 10
```

**Arguments:**
- `id` — Unique schedule identifier (used as `trigger.ref` in workflows)
- `name` — Human-readable label

**Options:**
- `-d`, `--description` — What this schedule does
- `-p`, `--pattern` — Cron expression, e.g. `0 9 * * *`
- `-e`, `--every` — Interval in milliseconds, minimum 1000
- `--tz` — IANA timezone for cron, e.g. `Europe/Berlin`
- `-l`, `--limit` — Maximum number of executions (omit for infinite)

You must provide either `--pattern` or `--every`, not both.

### Delete a schedule

```sh
schedule delete "<id>"
```

### Trigger a schedule manually

Fires the schedule immediately without affecting its execution count:

```sh
schedule trigger "<id>"
```

## Examples

Create a daily 9 AM schedule (Berlin time):

```sh
schedule create "daily-motd" "Daily MOTD" -d "Generates a message of the day" -p "0 9 * * *" --tz "Europe/Berlin"
```

Create a schedule that runs every 5 minutes:

```sh
schedule create "health-check" "Health Check" -d "Periodic system health check" --every 300000
```

Create a schedule with a 10-execution limit:

```sh
schedule create "onboarding" "Onboarding Reminders" -d "Sends onboarding reminders weekly" -p "0 10 * * 1" --limit 10
```

List all schedules:

```sh
schedule list
```

Whenever the result is user-facing, present it as a table.
Columns (translate in case): ID, Name, Pattern, TZ, Limit, Completed, Runs Left, Next run
No additional description column!

Delete a schedule:

```sh
schedule delete "daily-motd"
```
