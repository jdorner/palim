---
name: workflow-step-types
description: Reference for all workflow step types - agent, http-request, fail, set-variables, if, case, iterator/aggregator, waitFor, emit - with their fields and behavior
---
# Workflow Step Types

Field-by-field reference for every step type available in a workflow's `steps` map. For how to wire steps into a graph, template variables, triggers, and the execution model, read the `workflow-writing` skill (`skill read workflow-writing`).

Prefer deterministic step types (`http-request`, `set-variables`, `if`, `case`, `iterator`/`aggregator`, `fail`, `emit`, `waitFor`) over `agent` steps; use an `agent` step only when no deterministic type fits.

## Agent step

Runs an LLM prompt. The agent's text response becomes the step result.

```json5
"extract-data": {
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
"update-tasks": {
  "type": "agent",
  "tools": ["exec", "write_file"],
  "skills": ["task-list", "memory-management"],
  "prompt": [
    "Review the current task list and mark completed items.",
    "Update the memory file with a summary of changes.",
  ],
}
```

## HTTP Request step

Makes an outbound HTTP request. The response body becomes the step result (provided by the `core-wf-steps` extension).

```json5
"notify-slack": {
  "type": "http-request",
  "url": "{{env.SLACK_WEBHOOK_URL}}",
  "method": "POST",
  "body": "{\"text\": \"Invoice {{steps.extract-data.result.invoice}} processed.\"}",
}
```

Additional options: `headers` (an object of key-value string pairs; **omit it entirely if you have no custom headers** — do not set it to an empty string), `timeout` (ms, default 30000), `responseFormat` (`"json"` or `"text"`), `expectedStatus` (array of acceptable status codes). When a `body` is present and no `Content-Type` header is set, `application/json` is applied automatically.

```json5
// With custom headers:
"headers": { "Authorization": "Bearer {{secret.API_TOKEN}}" }
```

## Fail step

Immediately aborts the workflow run with a configurable error message (provided by the `core-wf-steps` extension). Use this on a branch where reaching that path means the workflow cannot continue (e.g. an unexpected `case` branch).

```json5
"abort-unexpected": {
  "type": "fail",
  "message": "Unexpected category: {{steps.classify.result}}",
}
```

The `message` field is optional (defaults to "Workflow aborted by fail step") and supports `{{template}}` expressions. When executed, the step logs the message, throws an error, and the entire run is marked failed (fail-fast).

## Set Variables step

Defines workflow-local variables (provided by the `core-wf-steps` extension). Use it to compute a value once (e.g. a composed string) and reuse it in several later steps, or to build up a value inside an iterator. Later steps read each variable as `{{steps.<slug>.result.<name>}}`.

```json5
"names": {
  "type": "set-variables",
  "variables": [
    { "name": "fileName", "value": "{{trigger.payload.user}}-report.md" },
    { "name": "outPath", "value": "outbox/{{steps.names.result.fileName}}" },
    { "name": "limit", "value": "25", "type": "number" },
  ],
}
```

- `name`: letters, digits and `_`, not starting with a digit. Must be unique within the step.
- `value`: a literal or a `{{template}}`.
- `type` (optional): `string` (default), `number`, `boolean` or `json`. The resolved value is converted to this type, and the step fails if it can't be.
- Entries are evaluated in order. Inside the step, `{{steps.<own-slug>.result.<name>}}` is the variable's current value: the value set by an earlier entry, else the value from the step's previous execution, else `""` / `0` / `false` / `null`.
- To accumulate inside an iterator body, reference the variable's own previous value. After the aggregator, the result holds the last pass's value:

```json5
"acc": {
  "type": "set-variables",
  "variables": [{ "name": "text", "value": "{{steps.acc.result.text}}{{item.name}}, " }],
}
```

Outside an iterator body there is no previous pass, so a self-reference to the variable's own value is always the zero value (the validator warns).

## If step (conditional branching)

Evaluates a condition against a resolved template value. It is NOT dispatched as a job — the engine evaluates it inline when its incoming edges are satisfied. The `then` and `else` branches are expressed as **edges**, not nested arrays.

```json5
{
  "steps": {
    "extract-data": {
      "type": "agent",
      "tools": ["exec"],
      "prompt": "Extract priority from: {{trigger.payload}}",
    },
    "check-priority": {
      "type": "if",
      "condition": {
        "ref": "{{steps.extract-data.result.priority}}",
        "eq": "high",
      },
    },
    "urgent-notify": {
      "type": "agent",
      "tools": ["send_telegram_message"],
      "prompt": "Send an urgent notification: {{steps.extract-data.result}}",
    },
    "log-low-priority": {
      "type": "agent",
      "tools": ["write_file"],
      "prompt": "Append to the low-priority log: {{steps.extract-data.result}}",
    },
  },
  "edges": [
    { "from": "extract-data", "to": "check-priority" },
    // Branch edges MUST carry a "branch" property on if/case nodes
    { "from": "check-priority", "to": "urgent-notify", "branch": "then" },
    { "from": "check-priority", "to": "log-low-priority", "branch": "else" },
  ],
}
```

If the chosen branch is `then`, the `then` edges become `satisfied` and the `else` edges become `dead` (and vice versa). Dead edges propagate downstream so any step reachable only through a dead branch is skipped.

### Condition operators

The `condition` object requires a `ref` field (template expression to resolve) and exactly one operator:

| Operator | Description | Example |
|----------|-------------|---------|
| `eq` | String equality after `String()` coercion | `"eq": "success"` |
| `neq` | Logical negation of eq | `"neq": "error"` |
| `gt` | Greater than (numeric if both parseable, otherwise lexicographic) | `"gt": 100` |
| `gte` | Greater than or equal | `"gte": 0` |
| `lt` | Less than | `"lt": 50` |
| `lte` | Less than or equal | `"lte": 1000` |
| `in` | Membership in array (String coercion per element) | `"in": ["draft", "review", "published"]` |
| `contains` | Case-sensitive substring check | `"contains": "error"` |
| `exists` | Not null, not undefined, not empty string | `"exists": true` |
| `matches` | Regex test against String(value) | `"matches": "^\\d{4}-\\d{2}-\\d{2}$"` |

For `null` or `undefined` resolved values, all operators except `exists` return false without performing the comparison.

## Case step (multi-way branching)

Resolves a `match` template and routes to the matching branch. The `paths` field is an **array of branch key strings** (not nested step arrays). Branch steps are separate top-level steps connected via edges whose `branch` matches a path key. An optional `default` names the fallback branch key.

```json5
{
  "steps": {
    "classify": {
      "type": "agent",
      "tools": [],
      "prompt": "Classify the document as 'invoice', 'receipt', or 'other': {{trigger.payload}}",
    },
    "route-by-type": {
      "type": "case",
      "match": "{{steps.classify.result}}",
      "paths": ["invoice", "receipt"],
      "default": "receipt",
    },
    "process-invoice": {
      "type": "agent",
      "tools": ["exec"],
      "prompt": "Process the invoice: {{trigger.payload}}",
    },
    "process-receipt": {
      "type": "agent",
      "tools": ["write_file"],
      "prompt": "Archive the receipt: {{trigger.payload}}",
    },
  },
  "edges": [
    { "from": "classify", "to": "route-by-type" },
    { "from": "route-by-type", "to": "process-invoice", "branch": "invoice" },
    { "from": "route-by-type", "to": "process-receipt", "branch": "receipt" },
  ],
}
```

Path matching is exact and case-sensitive (no trimming). If the resolved value matches no path and no `default` is set, the run fails.

## Iterator + Aggregator (data-driven loop)

Iterates over an array, executing the body steps once per element. Uses two paired nodes: an **iterator** (splits the array, opens the loop scope) and an **aggregator** (collects results, drives re-execution or completes).

The body steps between them are regular top-level nodes — they show up in the graph, get their own status/logs, and can be any step type.

**Iterator definition:**

```json5
"iter": {
  "type": "iterator",
  "items": "{{trigger.payload}}",  // template expression resolving to a JSON array
  "as": "image",                   // optional, variable name for current element (default: "item")
}
```

**Aggregator definition:**

```json5
"collect": {
  "type": "aggregator",
  "iterator": "iter",  // slug of the paired iterator
}
```

**Wiring:** The iterator's outgoing edge must have `branch: "each"`. Body steps connect sequentially between iterator and aggregator with regular (unlabeled) edges.

```json5
"edges": [
  { "from": "iter", "to": "convert", "branch": "each" },
  { "from": "convert", "to": "collect" },
  { "from": "collect", "to": "downstream-step" },
]
```

**Template variables inside the loop body:**

- `{{<as>}}` (e.g. `{{image}}`) — the current array element
- `{{<as>.<field>}}` (e.g. `{{image.dataUrl}}`) — dot-path into the current element
- `{{itemIndex}}` — zero-based iteration index

**Aggregator result:** After all iterations complete, the aggregator's result is available downstream as `{{steps.<aggregator-slug>.result}}` containing `{ results: [...], totalItems, succeeded, failed }`.

**Full example:**

```json5
{
  "name": "process-scans",
  "trigger": { "type": "webhook", "ref": "scan-app" },
  "steps": {
    "iter": {
      "type": "iterator",
      "items": "{{trigger.payload}}",
      "as": "image",
    },
    "ocr": {
      "type": "http-request",
      "url": "http://localhost:3000/ext/converter/convert",
      "method": "POST",
      // The webhook delivers images as data URIs (data:image/...;base64,...),
      // but the converter's `data` field expects raw base64. stripDataUri removes
      // the prefix; jsonEscape keeps the value safe inside the JSON body.
      "body": "{\"data\": \"{{ jsonEscape(stripDataUri(image.dataUrl)) }}\"}",
      "responseFormat": "json",
      "timeout": 120000,
    },
    "collect": {
      "type": "aggregator",
      "iterator": "iter",
    },
    "summarize": {
      "type": "agent",
      "prompt": "Summarize OCR results: {{steps.collect.result.results}}",
    },
  },
  "edges": [
    { "from": "iter", "to": "ocr", "branch": "each" },
    { "from": "ocr", "to": "collect" },
    { "from": "collect", "to": "summarize" },
  ],
}
```

**Rules:**
- Every iterator must have exactly one aggregator referencing it (via the aggregator's `iterator` field)
- The aggregator must be reachable from the iterator's `each` branch
- The iterator's outgoing edges must all carry `branch: "each"` (it is a CF node)
- The aggregator has regular (unlabeled) outgoing edges
- Iteration is sequential — each item runs through the full body before the next starts
- If a body step fails, the entire run fails (fail-fast)

## WaitFor step (signal gate)

Pauses its own branch and releases the worker slot until an external signal is delivered via the API. In the DAG model, `waitFor` is a regular node: it blocks only its own successors — independent branches keep running.

```json5
"await-approval": {
  "type": "waitFor",
  // Signal event name (lowercase, dots/hyphens allowed)
  "event": "approval.granted",
  // Optional timeout in ms (1 second to 7 days). Run fails if exceeded.
  "timeout": 86400000, // 24 hours
  // Optional JSON Schema for validating the incoming signal payload
  "inputSchema": {
    "type": "object",
    "properties": {
      "approver": { "type": "string" },
      "comment": { "type": "string" },
    },
    "required": ["approver"],
  },
  // Optional: who may resume the wait (default "broadcast")
  //   "broadcast" - emit steps and direct delivery
  //   "instance"  - only direct delivery to this run (see below)
  "scope": "instance",
  // Optional correlation key, resolved when the wait is reached.
  // Only emits carrying the same key resume this wait.
  "correlate": "{{trigger.payload.orderId}}",
}
```

When the signal arrives, its payload becomes the step result. Successor steps access it via `{{steps.await-approval.result}}` or `{{steps.await-approval.result.approver}}`.

### Delivering a signal

Every waiting step of every run has its own address, so a signal resumes exactly one wait. Deliver it with a POST (JSON body = payload):

```
POST /ext/workflows/runs/<runId>/steps/<stepSlug>/signal   # preferred: one step of one run
POST /ext/workflows/signals/<signalId>                     # signal ID from GET /ext/workflows/runs/<runId>
POST /ext/workflows/runs/<runId>/signal/<event>            # by event; 409 if several steps wait on it
Content-Type: application/json

{ "approver": "joe", "comment": "Looks good" }
```

To let an external system call back into the right run, pass it the address from a template: `/ext/workflows/runs/{{run.id}}/steps/await-approval/signal`.

Response codes:
- `200` - Signal accepted, workflow resumed
- `404` - Run or signal not found
- `409` - Not waiting (already delivered, timed out, run ended), or the event matches several steps
- `422` - Payload fails inputSchema validation

A timeout survives restarts: after a restart, pending timeouts are re-armed and already elapsed ones fire immediately.

### Event name rules

Event names must match `^[a-z][a-z0-9._-]*$` (max 128 characters). Examples: `approval.granted`, `deploy-ready`, `data.processed`.

## Emit step (cross-workflow signal)

Sends a named signal to workflows currently waiting for that event. The emitting branch continues immediately (fire-and-forget).

```json5
"notify-ready": {
  "type": "emit",
  // Signal event name to broadcast
  "event": "data.processed",
  // Optional payload template (resolved before emission)
  "payload": "{{steps.transform.result}}",
  // Optional: only resume waits with this correlation key
  "correlate": "{{trigger.payload.orderId}}",
  // Optional: only resume waits of this run (e.g. a run started by start-workflow)
  "targetRun": "{{steps.start-child.result.workflowRunId}}",
}
```

Which waits an emit resumes:
- only `waitFor` steps with `scope: "broadcast"` (the default); `instance` waits are never reached by emit
- a wait with a `correlate` key only when the emit carries the same key; a wait without a key on any emit of the event
- with `targetRun`, only waits of that run
- never waits of the emitting run itself

Without `correlate` or `targetRun`, every unkeyed wait on the event, in every run, is resumed. To address a single workflow instance, use a correlation key, `targetRun`, or direct delivery.
