# Portal

The portal is the end-user app of Palim. The Palim web interface is an operator console: everyone signed in there can read workflows, jobs and logs. The portal is for people who should only do their part, without access to any of that. Its first module is the **task inbox**: workflows ask a person to approve something, pick an option or enter data, and that person answers in the portal.

The portal is a small, mobile-first web app in `portal/`. It talks to Palim only through `/api/auth/*`, `/api/portal/*` and `/api/i18n/*`.

## Setting It Up

### Build

```bash
cd portal
bun install
bun run build
```

`bun run setup` builds the portal together with the operator frontend. When `portal/dist` exists, Palim serves it at `/portal/`, e.g. `http://localhost:3000/portal/`. Rebuild after updating Palim.

### Hosting It Elsewhere

The build is a static app, so you can also host `portal/dist` on any web server or domain. Edit `config.json` next to `index.html` to point it at Palim:

```json
{ "palimUrl": "https://palim.example.com" }
```

Leave `palimUrl` empty when the portal runs on the same origin as Palim (served at `/portal/`, or behind a reverse proxy that forwards `/api` to Palim). The same build works everywhere, only `config.json` changes.

### Public URL

Set `PORTAL_PUBLIC_URL` in `.env` to the address users open, e.g. `https://palim.example.com/portal`. Palim shows it to portal accounts that sign in to the operator interface by mistake.

## Portal Accounts

Create the people who use the portal on the **Users** page:

1. Set the kind to **Portal**. A portal account can only reach the portal API: no other API routes, no WebSocket, no operator data.
2. Give it the built-in role **portal-user** (`hitl:respond`).
3. To assign tasks to groups instead of single people, create custom roles (e.g. `accounting`) with only `hitl:*` permissions and add them to the accounts. Portal accounts can't hold roles with other permissions.

Operator accounts can use the portal too. The built-in `user` role includes `hitl:respond`, and `admin` also has `hitl:manage`. See [the API security model](api-security-model.md#portal-accounts) for the full rules.

## Answering Tasks

After signing in, the inbox lists the open tasks assigned to you, directly or through one of your roles, with priority and due date. **Done** lists the tasks you answered. The list updates live while the portal is open, and the badge in the navigation shows how many tasks are open.

A task page shows:

- the description (markdown) and any context values the workflow attached,
- a form, when the workflow asks for data,
- a comment field (required for some tasks),
- one button per possible answer (e.g. **Approve** / **Reject**),
- the history of the task.

The first answer wins. When someone else answered or changed the task while you had it open, the portal tells you so and your answer is not saved; the history shows who answered. Tasks that were cancelled or expired are no longer answerable.

**Settings** lets you change the language and sign out. On a phone, you can add the portal to the home screen to use it like an app.

## Asking People From Workflows

A workflow creates a task with a `humanTask` step and pauses that branch until someone answers. The answer (`outcome`, form `data`, `comment`, who answered and when) becomes the step result, so the next steps can branch on it. See [Human Tasks](extensions/workflows.md#human-tasks) in the workflows docs for the step reference.

Assign tasks by user name or role:

```json5
"assignees": { "users": ["alice"], "roles": ["accounting"] }
```

## Notifying People

Palim doesn't notify assignees about new tasks yet. Add a notify step next to the `humanTask` step instead, so people know there is something to do. Both steps start from the same predecessor, so the notification goes out while the task waits:

```json5
{
  steps: {
    extract: { type: "agent", prompt: "Summarize invoice {{trigger.payload.number}}" },
    review: {
      type: "humanTask",
      title: "Approve invoice {{trigger.payload.number}}",
      body: "{{steps.extract.result}}",
      assignees: { roles: ["accounting"] },
    },
    "notify-review": {
      type: "notify-ntfy",
      title: "Invoice {{trigger.payload.number}} needs approval",
      message: "Please review it in the portal.",
      click: "{{var.PORTAL_URL}}",
    },
  },
  edges: [
    { from: "extract", to: "review" },
    { from: "extract", to: "notify-review" },
  ],
}
```

Store the portal address as a global variable (here `PORTAL_URL`) so every workflow links to the same place. The task ID is only known after the step started, so the link opens the inbox rather than the task. `notify-telegram` works the same way with the link in the `message`.

## Managing Tasks

Users with `hitl:manage` see all tasks, can answer any of them, and can cancel or reassign them. In the operator interface, the run page of a waiting workflow shows its task with assignees and due date, and lets managers cancel it. A cancelled task fails its workflow run, and a run that fails or is deleted cancels its open tasks.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/portal/tasks` | Tasks visible to you (`scope=mine\|completed\|all`, `status`, `limit`, `cursor`) |
| `GET` | `/api/portal/tasks/counts` | Open and due-soon counts |
| `GET` | `/api/portal/tasks/:id` | Task with history (`404` when not visible to you) |
| `POST` | `/api/portal/tasks/:id/complete` | Answer: `outcome`, `data`, `comment`, `version` (`409` already answered or changed, `422` invalid answer) |
| `POST` | `/api/portal/tasks/:id/cancel` | Cancel (`hitl:manage`) |
| `PATCH` | `/api/portal/tasks/:id/assignees` | Reassign (`hitl:manage`) |
| `GET` | `/api/portal/events` | Server-sent events: `ready`, `task_created`, `task_updated`, `task_removed` |

All routes need a bearer token from `POST /api/auth/login`. The event stream also takes it in the `Authorization` header, so read it with a streaming `fetch` rather than `EventSource`.
