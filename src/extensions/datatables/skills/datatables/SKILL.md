---
name: datatables
description: Read and write structured data tables (lists, lookups, collected records) with the `datatable` command
---
# Data Tables

Data tables are typed, structured tables that users define in the **Data Tables** page.
Workflows read and write them too. Use the `datatable` command to inspect and change their rows.
You cannot create tables or change their columns. Ask the user to do that in the UI.

## Commands

```bash
datatable list                                  # all tables with row counts
datatable schema <table>                        # columns, types, key column
datatable query <table> [options]               # read rows
datatable insert <table> '<json>'               # add rows
datatable upsert <table> '<json>' [--key col]   # insert or update by key column
datatable update <table> --where ... --set col=value [--set ...]
datatable delete <table> --where ... | --id <id>
datatable truncate <table>                      # delete ALL rows (confirm with the user first)
```

### Query options

- `--where col:op:value` (repeatable, all must match), or the shorthand `--where col=value`.
  - Operators: `eq ne lt lte gt gte contains startsWith in isNull notNull`.
  - `in` takes a comma-separated list: `--where status:in:open,pending`.
  - `isNull`/`notNull` take no value: `--where email:isNull`.
- `--sort col [--desc]`, `--limit n` (default 50, max 1000), `--offset n`.
- `--json` prints the raw result: `{ rows, total }`.
- Every row has the metadata fields `_id`, `_createdAt` and `_updatedAt`. You can filter and sort on them.

### Writing rows

- Pass JSON with column keys: one object or an array of objects.
  - Example: `datatable insert contacts '[{"name":"Ada","email":"ada@example.com"}]'`.
- For large data, read from a file in the work directory (`--file data/rows.json`) or pipe it in (`cat rows.json | datatable insert contacts`).
- Values are converted to the column type. `"42"` becomes 42, and `"ja"`/`"yes"`/`"true"` become true.
  - Dates are written as `YYYY-MM-DD` (`01.03.2024` is also accepted).
  - Date-times use ISO 8601.
- An insert is all-or-nothing. If any row fails validation (wrong type, missing required value, duplicate in a unique column), nothing is written and the errors are listed.

## Rules

- Run `datatable schema <table>` before writing, so you use the right column keys and types.
- Prefer `upsert` over `insert` when a table has a key column and the record may already exist.
- Confirm with the user before running `truncate`, or a `delete`/`update` that affects many rows.
