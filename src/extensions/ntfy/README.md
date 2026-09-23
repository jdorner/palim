# ntfy

Send push notifications via [ntfy.sh](https://ntfy.sh) (or a self-hosted ntfy server) from your workflows. The extension registers a deterministic `notify-ntfy` workflow step type that publishes a notification to a topic. It does **not** register an agent tool - notifications are sent through the workflow step only.

Publishes by POSTing to the [ntfy HTTP API](https://docs.ntfy.sh/publish/).

## Enabling

Enable the extension in the web UI under **Settings > Extensions** by toggling the switch next to "ntfy". New external extensions start disabled, so this step is required before the `notify-ntfy` step type appears in the workflow editor.

## Prerequisites

None for public topics on `https://ntfy.sh`. You only need an access token if you publish to a protected topic (a server with access control enabled).

Subscribe to your topic in the ntfy mobile/desktop app or web UI to receive notifications. Topics are created on the fly - there is no sign-up.

## Settings

Configurable in the web UI under **Settings > Extensions > ntfy**.

| Setting | Description | Default |
| --- | --- | --- |
| ntfy Server URL | Base URL of the ntfy server. | `https://ntfy.sh` |

### Environment variable overrides

| Setting | Environment Variable |
| --- | --- |
| ntfy Server URL | `EXT_NTFY_SERVER` |

## Secrets

| Secret | Description |
| --- | --- |
| `NTFY_ACCESS_TOKEN` | Optional access token for publishing to protected topics (optional) |
| `NTFY_DEFAULT_TOPIC` | Default topic used when a step does not specify one (optional) |

Set these in **Settings > Extensions > ntfy > Secrets**. Updating or deleting a secret takes effect immediately without a restart.

The access token is sent in the request `authorization` field.

The default topic is stored as a secret rather than a plain setting because a topic name is effectively a shared credential: on an unauthenticated ntfy server, anyone who knows the topic can subscribe to and publish on it. If no default topic is set, every step must provide a `topic`, otherwise the step fails with `No topic provided and no default topic configured.`

## The `notify-ntfy` step type

A deterministic (non-LLM) step that publishes a single notification. Because it calls the ntfy publish path directly, delivery is reliable, incurs no token cost, and is testable.

The server URL and access token stay encapsulated in the extension and never appear in workflow files.

### Configuration

| Field | Required | Description |
| --- | --- | --- |
| `message` | yes | Notification body. Supports `{{template}}` expressions. |
| `title` | no | Notification title. Supports `{{template}}` expressions. |
| `topic` | no | Target topic. Supports `{{template}}` expressions. Falls back to the secret default topic. To avoid a plaintext topic in the workflow file, leave this empty (use the default) or reference a secret with `{{secret.KEY}}`. See [Keeping topics out of workflow files](#keeping-topics-out-of-workflow-files). |
| `click` | no | URL opened when the notification is tapped (ntfy click action). Supports `{{template}}` expressions. |
| `markdown` | no | Render the message body as Markdown. Defaults to off (plain text). |
| `priority` | no | `"1"` (min) to `"5"` (max). Defaults to the ntfy server default (3). |
| `tags` | no | List of tags. Known emoji shortcodes render as emoji; any other value shows as a plain text tag. |

Notes:

- `message`, `title`, `topic`, and `click` support template expressions, so they can pull context from the trigger payload or previous step results (e.g. `{{steps.build-message.result}}`).
- `click` accepts an `http(s)://` URL (opens the browser or app) or another scheme such as `mailto:`, `geo:`, or `ntfy://` for deep links.
- `markdown` enables Markdown rendering of the body (bold, links, lists, etc.). This is currently honored by the ntfy web app only; other clients display the raw text. See the [ntfy Markdown docs](https://docs.ntfy.sh/publish/#markdown-formatting).
- `priority` is a string in the editor (`"1"`-`"5"`); it is normalized to the numeric ntfy priority at run time.
- The editor's tag input offers autocomplete for common emoji shortcodes (showing the emoji next to each, e.g. `⚠️ warning`) and also accepts arbitrary custom tags that do not map to an emoji.
- If the resolved `message` is empty, the step fails with `notify-ntfy step: resolved message is empty`.
- Template resolution warnings are written to the job log; they do not fail the step.

### Keeping topics out of workflow files

A ntfy topic name is effectively a shared credential: on an unauthenticated server, anyone who knows the topic can subscribe to and publish on it. The step's `topic` field is a normal templated string, so any value you type there is stored in plaintext in the workflow definition file (and appears in run logs). The workflow editor deliberately keeps this field a plain text input rather than a masked one, because masking would only hide it in the UI while leaving the value in the file, and it would break the `{{template}}` authoring the field is designed for.

To avoid putting a real topic name in a workflow file, use one of these patterns instead:

- **Rely on the default topic.** Leave `topic` empty and set the `NTFY_DEFAULT_TOPIC` secret (see [Secrets](#secrets)). The step falls back to it, and the value stays encrypted in the secret vault.
- **Reference a secret.** Store the topic as a global secret and reference it with `{{secret.KEY}}`, for example `topic: "{{secret.NTFY_ALERT_TOPIC}}"`. The workflow engine resolves `{{secret.*}}` against the encrypted vault at run time (ACL-checked and audit-logged, using the workflow's identity as the consumer), so only the secret key name, not the topic itself, appears in the workflow file.

Both keep the actual topic in the vault. A per-step literal topic (or one derived from `{{trigger.payload.*}}`) is still fine when the topic is not sensitive, e.g. a public topic or one on an access-controlled server.

### Result

The step returns:

```json
{ "sent": true, "topic": "<the topic delivered to>" }
```

Available to later steps as `{{steps.<slug>.result.topic}}`.

## Example

A workflow step (DAG JSON5) that alerts on a failed check, pulling the message from a previous step and the topic from the trigger payload:

```json5
{
  slug: "alert",
  type: "notify-ntfy",
  title: "Pipeline failed",
  message: "{{steps.build-report.result}}",
  topic: "{{trigger.payload.topic}}",
  click: "{{trigger.payload.runUrl}}",
  priority: "5",
  tags: ["rotating_light", "skull"]
}
```

With a default topic configured, `topic` can be omitted and the notification goes to the configured default.

## How it works

1. The step definition is validated against the config schema.
2. `message`, `title`, `topic`, and `click` templates are resolved; warnings are logged.
3. The extension POSTs to the resolved topic (or the default) on the configured server, mapping fields to ntfy headers (`X-Title`, `X-Click`, `X-Markdown`, `X-Priority`, `X-Tags`) with the message as the request body and the access token as a Bearer `Authorization` header.
4. The step logs `Notification sent to topic <topic>` and returns `{ sent: true, topic }`.

Any publish failure fails the step (and, following workflow fail-fast semantics, the run).
