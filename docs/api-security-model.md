# API Security Model

## Overview

Palim protects its HTTP API and WebSocket with **local user accounts** and **role-based access control (RBAC)**. Every request to `/api/*` or `/ext/*` must carry a bearer token that belongs to a user. The token decides who is calling, and that user's roles decide what the call may change.

Palim is a tool for developers, so **reading is open**: every signed-in user can see everything except other users' chat conversations and the jobs that process them. Roles only guard writes and management.

Extensions, skill scripts and workflows also call the API internally. They never hold a shared master token. Instead, each internal call runs as **the user who started the work**, or as a narrow built-in `system` principal when no user is involved. An extension can't borrow more authority than the person who triggered it.

## Architecture

```text
┌──────────────────────────────────────────────────────────────────────┐
│                           Palim Process                              │
│                                                                      │
│  ┌──────────────────┐        ┌────────────────────────────────────┐  │
│  │  Users & roles   │        │         Elysia Web Server          │  │
│  │  (SQLite)        │        │                                    │  │
│  │                  │◀────▶│  authCheck middleware              │  │
│  │  • accounts      │        │   1. skip public paths             │  │
│  │  • roles →       │        │   2. token → user (401 if none)    │  │
│  │    permissions   │        │   3. route rule table (403)        │  │
│  │  • token hashes  │        │  route handlers                    │  │
│  └──────────────────┘        │   4. chat ownership checks (404)   │  │
│                              └────────────────────────────────────┘  │
│                                               ▲                      │
│  ┌──────────────────────────────────┐         │ Bearer <token of     │
│  │  Jobs (chat, agent, workflows)   │         │ initiating user or   │
│  │  run with the initiator's        │         │ system principal>    │
│  │  identity                        │         │                      │
│  │                                  │         │                      │
│  │  extension ctx.fetch ────────────┼─────────┘                      │
│  │  skill script ctx.fetch          │  confined to /ext/<name>/*     │
│  │                                  │  (+ /api/push)                 │
│  └──────────────────────────────────┘                                │
└──────────────────────────────────────────────────────────────────────┘
          ▲                                       ▲
          │ Bearer token from login               │ Per-webhook auth
          │                                       │ (HMAC / bearer / none)
┌─────────┴─────────┐                   ┌─────────┴──────────┐
│  Web UI / clients │                   │ External services  │
│  POST /api/auth/  │                   │ POST /ext/webhooks │
│  login            │                   │ /receive/:slug     │
└───────────────────┘                   └────────────────────┘
```

## Users and first boot

On first boot, while the users table is empty, Palim seeds an **admin account** and assigns it everything that previously had no owner (existing chat sessions, file watchers, webhooks).

| Variable | Purpose | Default |
| -------- | ------- | ------- |
| `AUTH_ADMIN_USER` | Username of the seeded admin | `admin` |
| `AUTH_ADMIN_PASSWORD` | Password of the seeded admin. When empty, a strong one-time password is generated and printed to the log once. | — |
| `AUTH_SESSION_TTL_MS` | Lifetime of a login token | `604800000` (7 days) |

These only apply to seeding. Once any user exists, changing them has no effect. Manage further accounts on the **Users** page (or via `/api/users`).

Palim also keeps a built-in `system` account. It has no usable password, so nobody can log in as it. It exists only so background work with no originating user has a narrow identity to run as. See [Internal calls](#internal-calls).

## Authentication

### Login and tokens

- `POST /api/auth/login` exchanges a username and password for an **opaque bearer token** and its expiry.
- Passwords are hashed with **argon2id**.
- Tokens are 32 random bytes. Only their **SHA-256 hash** is stored, so a database leak doesn't expose usable tokens.
- A token stops working when it expires, when the user logs out (`POST /api/auth/logout`), or when the account is disabled. Disabling an account also revokes all its tokens immediately.
- `GET /api/auth/me` returns the current user and their serialized permissions, which the web UI uses to hide actions the user can't perform.

The web UI keeps the token in `sessionStorage` and sends it as `Authorization: Bearer <token>`.

### WebSocket

WebSocket connections pass the token in the `Sec-WebSocket-Protocol` header, using the `auth-<token>` subprotocol convention. A connection without a valid token is closed with code `4001`.

Job, workflow, trigger and extension events go to every connected user, with one exception: **chat jobs** (jobs routed to a chat) are visible only to the user who started the chat, admins included. Their `job_added`, `job_updated`, `job_log` and `job_removed` events and their entries in `initial_state` snapshots are filtered per connection. A chat job with no recorded initiator is shown to no one.

Chat streams (`chat_event`, `push_message`) go only to the chat's owner, keyed by chat ID. Admins don't receive other users' streams either; they can read conversations through the sessions API. The first job to name a chat ID claims it, so later jobs can't take over another user's stream. A chat with no recorded owner is delivered to no one.

### Public endpoints

These endpoints need no token:

| Endpoint | Reason |
| -------- | ------ |
| `GET /health` | Health checks |
| `POST /api/auth/login` | Login |
| `POST /api/auth/validate` | Lets the frontend detect that login is required |
| `POST /ext/webhooks/receive/:slug` | External webhook delivery, authenticated per webhook (see below) |
| Static files (`/`, `/assets/...`) | Frontend bundle |

Everything else under `/api/` and `/ext/` returns `401` without a valid token. If the auth service fails to start, those routes return `503` rather than letting requests through.

## Authorization

### Roles and permissions

Every signed-in user may read everything without any permission: workflow definitions and runs, jobs and their logs, triggers, secret metadata and audit logs, variables, models and extensions. There are three exceptions:

- **Chat sessions** are private to their owner.
- **Chat jobs** are private to the user who started them, admins included. They are left out of the job feed (see [WebSocket](#websocket)), and the per-job routes (`GET /api/jobs/:id/logs`, `GET /api/jobs/:id/chain`, `POST /api/jobs/:id/cancel`, `POST /api/jobs/:id/retry`) answer `404` to anyone else. Bulk cleanup (`POST /api/queues/clean`) still removes finished jobs of every user by state.
- **Users and roles** are listed only for holders of `users:manage`.

Secret values are never returned by the API, so open reads don't expose them.

Writes need a permission. Permissions are `<domain>:<action>` strings. A role is a named set of permissions, and a user's effective permissions are the union of their roles.

| Permission | Grants |
| ---------- | ------ |
| `chat:write` | Create chat sessions and send messages in, clear or delete your own sessions |
| `workflows:write` | Start workflow runs and cancel, signal or delete any run |
| `workflows:manage` | Create, edit and delete workflow definitions. Definitions are shared, and runs started by other users' triggers execute them with those users' authority, so this is admin-level |
| `jobs:write` | Cancel, retry and clean jobs |
| `triggers:write` | Create, edit and delete any schedule, file watcher or webhook |
| `secrets:write` | Manage secrets |
| `variables:write` | Manage global variables |
| `models:write` | Change the selected model |
| `extensions:write` | Enable, disable and configure extensions |
| `users:manage` | Manage users, roles and role permissions |

Three roles are built in:

| Role | Permissions |
| ---- | ----------- |
| `admin` | Everything (superuser) |
| `user` | `chat:write`, `workflows:write`, `jobs:write`, `triggers:write`. No workflow definition edits, secrets, variables, models, extension settings or user management. |
| `system` | Reserved for the built-in `system` account: `chat:write` only. Never `users:manage` or `secrets:write`. |

Built-in role permissions are defined in code and re-applied on every boot, so they can't be edited. Create custom roles for other combinations.

### How a request is checked

1. **Authentication**: the token must resolve to an enabled user (otherwise `401`).
2. **Route rules**: a central table (`src/web/authorize.ts`) maps write routes to required permissions, for example user and role administration, secret and variable writes, job control, model selection, and extension settings (otherwise `403`). `GET` and `HEAD` requests are allowed unless a rule says otherwise (only user and role administration does). Extension writes (`/ext/*`) fail closed: each first-party route is listed explicitly (for example, MCP server changes need `extensions:write`, workflow definition edits need `workflows:manage`), and any `/ext/*` write not in the table needs `extensions:write`, which only admins have by default. An extension write route meant for regular users has to be added to the table.
3. **Chat ownership**: chat sessions belong to the user who created them. Non-admins can read and post only in their own sessions. A non-owner gets `404`, so the response doesn't reveal that the session exists.

### Trigger ownership

Schedules, file watchers and webhooks record an owner, and the runs they start act with the owner's authority. Anyone with `triggers:write` may change any trigger, so **editing a trigger makes the editor its new owner**. A user can't make an admin's trigger run modified configuration with admin rights. Firing a schedule manually runs it unchanged, as its owner.

### Admin safety rules

User administration refuses changes that would lock everyone out (`409 Conflict`):

- At least one **enabled** user must always hold the `admin` role.
- You can't disable your own account or remove your own `admin` role. Another admin has to do it.
- The `system` account can't be modified, and the `system` role can't be assigned to anyone.
- Built-in roles' permissions can't be edited.

If admin access is lost anyway (for example a forgotten password), run the break-glass command on the host:

```bash
bun run reset-admin [username]   # defaults to AUTH_ADMIN_USER
```

It re-enables the account (creating it if missing), adds the `admin` role, sets a new random password and prints it once, and revokes the account's existing tokens.

## Internal calls

Extensions (`ctx.fetch`) and skill scripts (`SkillScriptContext.fetch`) get a fetch wrapper instead of a token. For each request, the wrapper does the following:

- **Local server URLs** get an `Authorization` header with the **identity of the current job**. That is the user who started the chat, agent job or workflow run. Workflow steps get a short-lived token minted for the run's creator.
- **Confinement**: local requests are limited to the extension's own routes (`/ext/<name>/*`) plus `/api/push`. Anything else returns a `403` without reaching the network, so an extension can't call admin or secret endpoints on the user's behalf.
- **External URLs** pass through unchanged and never carry a token.

When no user is involved (boot-time or other genuinely background work), calls run as the `system` account. Its tokens are short-lived and renewed automatically.

In short, extension and skill code never sees a raw token, can't widen its reach beyond its own routes, and can't do more than the user who triggered it.

## Webhook endpoint security

Webhook receive endpoints are public but authenticate **per webhook**, independent of user accounts:

- `hmac-sha256`: signature validation (for example GitHub-style `X-Hub-Signature-256`)
- `bearer`: static token in a configurable header
- `none`: no authentication (only for trusted internal sources)

Signatures and tokens are compared in constant time. Each webhook's secret is stored in the database, not in environment variables.

## Secrets

Boot-time configuration lives in `.env`. When a `.env.keys` file is present, dotenvx decrypts an encrypted `.env` at startup; otherwise values are read as plaintext.

| File | Contents | Committed |
| ---- | -------- | --------- |
| `.env.example` | Template with all variables documented | ✅ |
| `.env` | Configuration (encrypted when `.env.keys` exists) | ✅ only when encrypted |
| `.env.keys` | Private decryption keys | ❌ (gitignored) |

Extension and workflow secrets are stored in the SecretVault (SQLite, AES-256-GCM) with per-secret consumer ACLs and an audit log. Any signed-in user can read secret metadata; changing secrets requires `secrets:write`. The agent sandbox has no direct access to either. See [Secrets](secrets.md) for details.

## Threat model summary

| Threat | Mitigation |
| ------ | ---------- |
| Unauthenticated API access | Bearer token required on all `/api/` and `/ext/` routes; fails closed if auth is unavailable |
| Stolen database | Only token hashes and argon2id password hashes are stored |
| A user exceeding their role | Central route rule table for all writes |
| Seeing other users' conversations | Ownership checks on chat sessions and chat jobs; WebSocket chat-stream and chat-job events delivered only to the owner |
| Borrowing another user's authority through a trigger | Editing a trigger re-binds it to the editor |
| Extension or skill acting as a "confused deputy" | Internal fetch runs as the initiating user and is confined to the extension's own routes |
| Token leakage to external services | Token injected only for local-origin URLs |
| Background work with excess privilege | Dedicated `system` principal without user-management or secret-write permissions |
| Admin lockout | Last-admin and self-lockout rules; `bun run reset-admin` for recovery |
| Disabled or departed users | Disabling revokes all tokens immediately |
| Webhook forgery | Per-webhook HMAC or bearer validation, constant-time comparison |
| Secret file compromise | Optional dotenvx encryption of `.env`; SecretVault encryption at rest |
| Unauthorized secret reads by extensions | Per-secret ACL and audit log |
