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
