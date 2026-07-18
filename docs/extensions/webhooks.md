# Webhooks (Core)

The Webhooks extension exposes authenticated HTTP endpoints that external services (GitHub, Stripe, CRMs, CI systems, etc.) can POST to. Incoming payloads emit domain events for downstream consumers like the workflows extension.

This is a core extension and cannot be disabled.

## How It Works

1. Webhook registrations are persisted in SQLite and loaded on startup
2. External services send POST requests to the receiver URL
3. The payload is authenticated (HMAC-SHA256, bearer token, or none in dev mode)
4. A `webhook:received` event is emitted with the parsed payload
5. Downstream consumers (e.g. workflows) react to the event

## Web UI

The extension registers a **Webhooks** page in the sidebar where you can create, edit, enable/disable, and delete webhooks.

## Settings

### Max Payload Size

Maximum allowed webhook payload size in bytes.

Default: `1048576` (1 MB)

| Setting | Environment Variable |
| --- | --- |
| Max Payload Size | `EXT_WEBHOOKS_MAX_PAYLOAD_SIZE` |

## Receiver URL

Each webhook is accessible at:

```text
POST /ext/webhooks/receive/:slug
```

Provide this URL to the external service that should trigger events.

## Authentication Types

| Type | Description | Header |
| --- | --- | --- |
| `hmac-sha256` | GitHub-style HMAC signature verification | `X-Hub-Signature-256` (default) |
| `bearer` | Simple bearer token comparison | `Authorization` (default) |
| `none` | No authentication (development mode only) | - |

For `hmac-sha256` and `bearer`, a secret (minimum 8 characters) must be provided at creation time.

In non-development environments (`NODE_ENV` is not `development`), `authType: "none"` is rejected for security.

## Configuration

Each webhook registration has:

| Field | Description |
| --- | --- |
| `slug` | Unique identifier (used in the receiver URL and as trigger ref) |
| `name` | Human-readable label |
| `authType` | Authentication method: `hmac-sha256`, `bearer`, or `none` |
| `secret` | Shared secret for authentication (not returned in API responses) |
| `headerName` | HTTP header containing the auth value (auto-set by default) |
| `enabled` | Toggle the webhook on/off |

## HTTP API

### GET /ext/webhooks/

List all webhook registrations (secrets are stripped).

### POST /ext/webhooks/

Create a new webhook.

### GET /ext/webhooks/:slug

Get a single webhook's details.

### PUT /ext/webhooks/:slug

Update an existing webhook.

### DELETE /ext/webhooks/:slug

Delete a webhook.

### POST /ext/webhooks/receive/:slug

The receiver endpoint that external services POST to.

## Using with Workflows

To trigger a workflow from a webhook, set the workflow's trigger to:

```json5
{
  "trigger": {
    "type": "webhook",
    "ref": "my-webhook-slug"
  }
}
```

The workflow receives the webhook payload as its trigger payload, accessible via the `{{trigger.payload}}` template variable.
