---
name: webhooks
description: Manage webhook endpoints that let external services trigger workflows via events
---
# Webhook Management

## Overview

Webhooks are HTTP ingress endpoints that accept POST requests from external services (GitHub, Stripe, CRMs, CI/CD pipelines, etc.). When a webhook receives a request, it verifies authentication and emits a `webhook:received` event on the event bus. Workflows subscribe to these events via their `trigger.ref` field to start runs automatically.

## When to use

- When the user wants to set up an integration with an external service
- When the user asks about webhooks, HTTP triggers, or external notifications
- When the user wants to list, inspect, or remove existing webhook endpoints

## ⚠️ Strict Operational Constraints

You MUST adhere to these rules to maintain system integrity:

PRIMARY METHOD ONLY: You MUST use the provided webhook commands (e.g., webhook create, webhook delete, webhook list) to manage all webhook states.
FORBIDDEN ACTION: Do NOT attempt to manage webhooks by manually editing configuration files (e.g., webhooks.json) via exec (using sed, echo, cat, vi, etc.).
RATIONALE: Manual file manipulation bypasses system validation, risks corrupting JSON structures, and leads to "Split-Brain" scenarios where the agent's perception of the system differs from the actual system state.
VERIFICATION PROTOCOL: After any destructive action (webhook delete) or modification (webhook update), you MUST run webhook list to verify that the system registry reflects your intended changes.
ONLY report success to the user once the verification step confirms the intended state has been reached. If verification fails, report the error and the current state of the system.

## Response Formatting Guidelines

When listing webhooks using `webhook list`, ensure you provide a comprehensive overview. This includes:

- The webhook slug/ID
- The human-readable name
- The authentication type (e.g., none, hmac-sha256, bearer)
- The current status (enabled/disabled)
- The endpoint URL
- **MANDATORY WORKFLOW CROSS-REFERENCE: The `webhook list` command only returns webhook metadata. To comply with the "comprehensive overview" requirement, you MUST cross-reference every webhook slug with the available workflows. You must search through the workflow definitions (using `workflow list` or by inspecting workflow files) to identify which workflows are subscribed to the webhook via their `trigger.ref` field. You MUST list these associated workflows in your response.**

## Command reference

### List all webhooks

```sh
webhook list
```

Whenever the result is user-facing, present it as a table.

### Get details for a specific webhook

```sh
webhook get "<slug>"
```

### Create a new webhook

```sh
webhook create "<slug>" "<name>" "<authType>" "<secret>"
```

- `slug`: URL-safe identifier (lowercase, alphanumeric, hyphens). The endpoint becomes `POST /ext/webhooks/receive/<slug>`
- `name`: Human-readable label
- `authType`: Either `hmac-sha256`, `bearer`, or `none`
- `secret`: The HMAC secret or bearer token (min 8 characters). Use `""` when authType is `none`

### Delete a webhook

```sh
webhook delete "<slug>"
```

### Update a webhook field

```sh
webhook update "<slug>" "<field>" "<value>"
```

Updatable fields: `name`, `authType`, `secret`, `enabled`

### Test a webhook locally

```sh
webhook test "<slug>" "<jsonPayload>"
```

Sends a properly authenticated test request to the webhook endpoint and shows the result. Ask the user before testing - it may trigger workflows with side-effects.

## Examples

### GitHub push notifications (HMAC-SHA256)

```sh
webhook create "github-push" "GitHub Push Events" "hmac-sha256" "my-github-secret-key"
```

### CI pipeline trigger (bearer token)

```sh
webhook create "ci-deploy" "CI Deploy Notification" "bearer" "my-ci-token-value"
```

### Open webhook (No authentication)

```sh
webhook create "motd-trigger" "MotD Pipeline Trigger" "none" ""
```

### Updating and cleaning up

```sh
webhook update "ci-deploy" "enabled" "false"
webhook update "ci-deploy" "name" "CI Deploy v2"
webhook delete "old-webhook"
```

## Connecting webhooks to workflows

Webhooks emit events - workflows consume them via `trigger.ref`. To create a webhook-triggered workflow, both resources must be created together. See the `workflows` skill for the full pattern and YAML schema.

Key rule: `trigger.ref` in the workflow YAML must match the webhook slug exactly, or the workflow will not start.

## Notes

- Webhook endpoints are available at `POST /ext/webhooks/receive/<slug>`
- HMAC-SHA256 webhooks expect the signature in the `X-Hub-Signature-256` header
- Bearer token webhooks expect the token in the `Authorization` header
- Webhooks with authType `none` accept requests without authentication
- Registrations are persisted to `webhooks.json`
- Webhooks do not dispatch jobs directly - they emit events that workflows subscribe to
- Multiple workflows can listen to the same webhook slug
