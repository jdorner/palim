# Core Workflow Steps (Core)

The Core Workflow Steps extension provides built-in, non-LLM step types for workflow pipelines. These are deterministic steps (I/O operations and control flow) that run without involving the agent.

This is a core extension and cannot be disabled.

## Step Types

### http-request

Makes an outbound HTTP request. The response becomes the step result. In a workflow's `steps` map, the slug is the map key (shown here as `notify-api`):

```json5
"notify-api": {
  "type": "http-request",
  "url": "https://api.example.com/notify",
  "method": "POST",
  "headers": {
    "Authorization": "Bearer {{secret.API_TOKEN}}"
  },
  "body": "{\"status\": \"complete\", \"id\": \"{{steps.process.result.id}}\"}",
  "timeout": 10000,
  "responseFormat": "json"
}
```

#### Configuration

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `url` | string | Yes | - | Request URL. Supports `{{template}}` expressions. |
| `method` | string | No | `POST` | HTTP method: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD` |
| `headers` | object | No | - | Custom request headers (key-value). Values support `{{template}}` expressions. |
| `body` | string | No | - | Request body. Supports `{{template}}` expressions. |
| `timeout` | number | No | `30000` | Request timeout in milliseconds (1000-300000). |
| `responseFormat` | string | No | `text` | How to parse the response: `json` or `text`. |
| `expectedStatus` | number[] | No | - | Acceptable HTTP status codes. If empty, any 2xx is accepted. |

#### Behavior

- When `responseFormat` is `"json"`, the response body is parsed and returned as a structured object. Downstream steps can access fields via `{{steps.<slug>.result.body.<path>}}`.
- When no `Content-Type` header is set and a body is provided, `Content-Type: application/json` is added automatically.
- If the response status does not match `expectedStatus` (or is not 2xx when `expectedStatus` is empty), the step fails with the status code and response body in the error message.
- Template expressions (`{{...}}`) in `url`, `body`, and header values are resolved before the request is made.

#### Result Shape

The step result is an object with:

```json5
{
  "status": 200,           // HTTP status code
  "body": { ... }          // Parsed JSON (responseFormat: "json") or raw text string
}
```

Access in downstream steps: `{{steps.<slug>.result.status}}`, `{{steps.<slug>.result.body}}`, or `{{steps.<slug>.result.body.field}}` for JSON responses.

### fail

Immediately aborts the workflow run with a configurable error message. This is a **terminal** step type: it has no successors and always fails the run (fail-fast). Use it on a control-flow branch where reaching that path means the workflow cannot continue — for example the `default` branch of a `case` node that should never be taken.

```json5
"abort-unexpected": {
  "type": "fail",
  "message": "Unexpected category: {{steps.classify.result}}"
}
```

#### Configuration

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `message` | string | No | `Workflow aborted by fail step` | Message included in the failure. Supports `{{template}}` expressions. |

#### Behavior

- Template expressions (`{{...}}`) in `message` are resolved before the step throws.
- The resolved message is written to the job log, then thrown as an error.
- The error triggers the engine's fail-fast handling: the run is marked `failed`, in-flight jobs are cancelled, and remaining pending steps are marked dead.
- Being terminal, a `fail` step should not have outgoing edges. In the DAG editor and graph it is rendered with a distinct terminal marker.

### start-workflow

Starts another named workflow in a **fire-and-forget** fashion. The step dispatches the target workflow and returns immediately once the run has been created and its jobs enqueued. It does **not** wait for the started workflow to finish, and the started run is fully independent: its success or failure does not affect the current run.

This is deliberately not a sub-workflow. There is no join, no result propagation, and no lifecycle coupling. Use it to kick off side-effect pipelines (notifications, cleanups, downstream processing) that should run on their own. If you need the started workflow's result, or want its failures to propagate, model it as an explicit dependency instead.

```json5
"kick-off-cleanup": {
  "type": "start-workflow",
  "workflowName": "nightly-cleanup",
  "payload": "{\"reason\": \"triggered by {{trigger.source}}\", \"id\": \"{{steps.process.result.id}}\"}"
}
```

#### Configuration

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `workflowName` | string | Yes | - | Name of the workflow to start. Supports `{{template}}` expressions. |
| `payload` | string | No | - | Payload passed to the started workflow. Supports `{{template}}` expressions. Parsed as JSON when possible, otherwise forwarded as a raw string. |

In the workflow editor, the `workflowName` field is populated with a dropdown of the currently loaded workflow names. This is backed by the `workflow-names` dynamic item provider, which resolves `ctx.workflows.names()` at request time (so it reflects hot-reloads). You can still type a `{{template}}` expression to pick the target at runtime.

#### Behavior

- Template expressions (`{{...}}`) in `workflowName` and `payload` are resolved before dispatch.
- The resolved `workflowName` is trimmed. If it resolves to an empty string, the step fails.
- When the resolved `payload` parses as JSON, it is forwarded as structured data so the started workflow can access fields via `{{trigger.<path>}}`. Otherwise it is forwarded as a raw string. When `payload` is omitted, the workflow is dispatched with no payload.
- Dispatch fails (and therefore the step fails) if the target workflow does not exist or is disabled.
- The step completes as soon as the target run is dispatched; the started run then proceeds independently.

#### Pre-transition validation

When the step immediately follows an agent step, its `validateInput` hook runs before the transition. If `workflowName` is a static literal (no `{{template}}`) that does not match any loaded workflow, validation fails with a diagnostic listing the available workflow names, giving the producing agent a chance to correct the target. Templated names are skipped (they can only be resolved at runtime) and are still guarded by the dispatch-time not-found/disabled checks above.

#### Result Shape

```json5
{
  "started": true,              // always true once dispatched (failures throw)
  "workflowName": "nightly-cleanup",
  "workflowRunId": "run_abc123" // id of the started (independent) run
}
```

Access in downstream steps: `{{steps.<slug>.result.workflowRunId}}`.
