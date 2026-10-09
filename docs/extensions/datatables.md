# Data Tables

The Data Tables extension stores structured data in typed tables that you define. Workflows and the agent can use them, for lookup lists, dedupe sets, collected records or results that must outlive a run. Tables live in Palim's database.

You can:

- define a table in the UI, or derive its columns from a CSV/Excel file;
- import CSV/XLSX data, then inspect, filter, edit and export it in the UI;
- change rows from workflows with six step types (insert, update, delete, truncate, upsert, query);
- read and write rows from the agent with the `datatable` command.

## The Data Tables page

Open **Data Tables** in the sidebar.

- **Table list**: every table with its row count. **New Table** opens the table editor and **Import File** opens the import wizard. Both need the `datatables:write` permission.
- **Table view**: a paged grid (50 rows per page).
  - Click a column header to sort it (ascending, descending, off).
  - **Filter** adds conditions, which must all match.
  - Double-click a cell to edit it. **Enter** saves and **Escape** cancels.
  - **Add row** inserts a row. Select rows to delete them, or use **Delete all rows**.
  - The page refreshes when a workflow or the agent changes the table.
- **Export**: downloads the current view, with filters and sort applied, as CSV (UTF-8 with BOM, formula-escaped) or Excel. Headers are the column labels. Export is only available in the UI.

## Columns

| Field | Description |
| --- | --- |
| Label | Display name. Used as the export header. |
| Key | Stable identifier used in row data, filters, templates and the agent command. Lowercase letters, digits and `_`, starting with a letter. |
| Type | `text`, `number`, `integer`, `boolean`, `date` (`YYYY-MM-DD`), `datetime` (ISO 8601, UTC) or `json` |
| Required | Rejects rows where the value is empty |
| Unique | Rejects rows whose non-empty value already exists in another row |
| Key column | At most one per table. Identifies a row for upserts, and is always required and unique. |
| Default | Value used when a new row leaves the column out |

All writes convert values to the column type, so strings from templates, files and the command line are stored typed:

- **Numbers**: both `1.5` and `1,5` are accepted, as are thousands separators (`1.234,56` or `1,234.56`).
- **Booleans**: `true`/`false`, `yes`/`no`, `ja`/`nein`, `1`/`0` and `x` are accepted.
- **Dates**: ISO dates and `DD.MM.YYYY` are accepted.
- A value that cannot be converted rejects the write.

### Changing columns

A table's columns can be edited at any time. Existing rows are migrated:

- **Renaming a key** keeps the column's values.
- **Removing a column** deletes its values from every row. You are asked to confirm.
- **Changing a type** converts the existing values. If some values can't be converted, or a required column would be left empty, the change is rejected and the affected rows are listed. **Save anyway** then clears the failing values.
- **Making a column unique** fails while it holds duplicate values.

## Importing CSV and Excel files

1. Choose a `.csv` or `.xlsx` file.
   - The CSV delimiter is detected automatically (`,`, `;`, tab or `|`).
   - Files that aren't valid UTF-8 are read as Windows-1252.
   - For workbooks, pick the sheet.
   - Untick **First row contains headers** if the file has none.
2. Pick the target:
   - **New table**: the columns are derived from the file. Each type is the narrowest one that fits every sampled value. Values with leading zeros, such as postal codes, stay text. Edit labels, keys, types, flags and the source column of each field before creating the table.
   - **An existing table**: **Append rows** or **Replace all rows**. Map each table column to a file column. The mapping is pre-filled by matching headers to column labels and keys.
3. Rows that fail validation are skipped. The result lists them by data row number.

Limits: 20 MB per file and 100,000 rows per import. Legacy `.xls` files are not supported; save them as `.xlsx` first.

## Workflow step types

All step types take a `table` field. The editor offers a dropdown of the existing tables, and the field also accepts `{{template}}` expressions. String values support templates and are converted to the column type.

`where` is a list of conditions that must all match: `{ column, op, value }`.

- Operators: `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `contains`, `startsWith`, `in` (comma-separated values), `isNull`, `notNull`.
- Besides the table's columns, conditions can use the row metadata `_id`, `_createdAt` and `_updatedAt`.

### datatable-insert

Inserts one row from `values`, several rows from `rows`, or both. The whole batch is written or nothing is.

```json5
"save-order": {
  "type": "datatable-insert",
  "table": "orders",
  "values": { "order_no": "{{trigger.payload.id}}", "amount": "{{trigger.payload.total}}" }
}
```

`rows` is a template that resolves to a JSON object or array of objects, for example `"{{steps.fetch.result.items}}"`. Output: `{ inserted, ids }`.

### datatable-upsert

Inserts rows, or updates the rows whose key column matches. `keyColumn` defaults to the table's key column. Updated rows keep the values of columns the input leaves out. It takes the same `values` and `rows` inputs as insert. Output: `{ inserted, updated, ids }`.

### datatable-update

Sets the columns in `set` on every row that matches `where`. Output: `{ updated }`.

```json5
"mark-paid": {
  "type": "datatable-update",
  "table": "orders",
  "where": [{ "column": "order_no", "op": "eq", "value": "{{trigger.payload.id}}" }],
  "set": { "paid": "true" }
}
```

### datatable-delete

Deletes the rows that match `where`. Without conditions, the step fails unless `all: true` is set. Output: `{ deleted }`.

### datatable-truncate

Deletes every row of the table. Output: `{ deleted }`.

### datatable-query

Returns the rows that match `where`, sorted by `orderBy` (with `desc`), up to `limit` rows (default 100, at most 1000).

Output: `{ rows, count, total, first }`.

- `first` is the first row, or `null` when nothing matches.
- When `table` is a fixed name, the editor knows the table's columns, so `{{steps.<slug>.result.first.<column>}}` autocompletes, as does `{{item.<column>}}` inside an iterator over `{{steps.<slug>.result.rows}}`. This works before the workflow is saved, and references to unknown columns are reported as template warnings.

```json5
"lookup-customer": {
  "type": "datatable-query",
  "table": "customers",
  "where": [{ "column": "email", "op": "eq", "value": "{{trigger.payload.from}}" }],
  "limit": 1
}
```

When a step follows an agent step, the engine checks that the step's table and columns exist before the transition. If they don't, the agent is asked to repair its output.

## Agent command

The `datatables` skill gives the agent a `datatable` command. It calls the extension's API with the identity of the current job, so the user's permissions apply.

```bash
datatable list
datatable schema <table>
datatable query <table> [--where col:op:value]... [--sort col] [--desc] [--limit n] [--json]
datatable insert <table> '<json>'        # or --file data/rows.json, or stdin
datatable upsert <table> '<json>' [--key col]
datatable update <table> --where ... --set col=value [--set ...] [--all]
datatable delete <table> --where ... | --id <id>
datatable truncate <table>
```

The agent can't create tables or change columns.

## HTTP API

Routes are mounted under `/ext/datatables/`.

- `GET` routes are open to every signed-in user.
- All other routes need `datatables:write`. The built-in `user` role has it.
- Errors return `{ error, details? }`. `details.rows` lists row-level errors.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/tables` | List tables with columns and row counts |
| POST | `/tables` | Create a table: `{ name, label?, description?, columns, keyColumn? }` |
| GET | `/tables/:name` | Table definition and row count |
| PUT | `/tables/:name` | Update: `{ label?, description?, columns?, renames?: { oldKey: newKey }, keyColumn?, force? }` |
| DELETE | `/tables/:name` | Delete the table and its rows |
| GET | `/tables/:name/rows` | Query: `filter` (JSON array of conditions), `sort`, `desc`, `limit` (≤ 1000), `offset` |
| POST | `/tables/:name/rows` | Insert: `{ rows: [...] }` |
| PUT | `/tables/:name/rows/:id` | Patch one row: `{ values }` |
| POST | `/tables/:name/rows/update` | Update by filter: `{ filters?, values }` |
| POST | `/tables/:name/rows/upsert` | Upsert: `{ rows, keyColumn? }` |
| POST | `/tables/:name/rows/delete` | Delete: `{ ids?, filters? }` (at least one) |
| POST | `/tables/:name/truncate` | Delete all rows |
| GET | `/tables/:name/export` | Download: `format=csv\|xlsx`, plus optional `filter`, `sort`, `desc` |
| POST | `/import/preview` | Multipart `file`, `headerRow?`, `sheet?`, `delimiter?`. Returns headers, inferred columns and sample rows |
| POST | `/import` | Multipart `file` + `options` (JSON): `{ mode: "create"\|"append"\|"replace", table, mapping?: { columnKey: fileColumnIndex }, headerRow?, sheet?, columns?, label?, keyColumn? }` |

After each change, the extension sends a `table_changed` UI event (`{ table, deleted? }`) to open pages.
