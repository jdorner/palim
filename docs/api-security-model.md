# API Security Model

## Overview

Palim uses a **token-based authentication** system to protect its HTTP API and WebSocket endpoints. A single `AUTH_TOKEN` environment variable controls access. When set, all API consumers must present it as a Bearer token.

The key design challenge: the agent's sandboxed skill scripts need to call the same protected API endpoints, but must never handle raw secrets directly. This is solved by an **authenticated fetch wrapper** injected at skill registration time.

## Architecture

```text
┌─────────────────────────────────────────────────────────────────────┐
│                          Palim Process                              │
│                                                                     │
│  ┌───────────────┐         ┌──────────────────────────────────┐     │
│  │  AUTH_TOKEN   │         │        Elysia Web Server         │     │
│  │  (encrypted   │         │                                  │     │
│  │   .env file)  │         │  ┌────────────────────────────┐  │     │
│  └───────┬───────┘         │  │      authCheck middleware  │  │     │
│          │                 │  │                            │  │     │
│          │ read once       │  │  • Skip /health, static    │  │     │
│          │ at boot         │  │  • Skip /api/auth/validate │  │     │
│          │                 │  │  • Skip /ext/webhooks/     │  │     │
│          ▼                 │  │    receive/* (public)      │  │     │
│  ┌───────────────┐         │  │  • Validate Bearer token   │  │     │
│  │ Skill Loader  │         │  │    on all other /api/      │  │     │
│  │               │         │  │    and /ext/ routes        │  │     │
│  │ Creates an    │         │  └────────────────────────────┘  │     │
│  │ authenticated │         │                                  │     │
│  │ fetch wrapper │         └──────────────────────────────────┘     │
│  └───────┬───────┘                        ▲                         │
│          │                                │                         │
│          │ inject ctx.fetch               │ HTTP requests           │
│          ▼                                │ with Bearer token       │
│  ┌───────────────────────────────────┐    │                         │
│  │        Skill Scripts              │    │                         │
│  │                                   │    │                         │
│  │  • filewatcher, webhook, wiki...  │────┘                         │
│  │  • Use ctx.fetch() for internal   │                              │
│  │    API calls (token injected      │                              │
│  │    automatically)                 │                              │
│  │  • Use globalThis.fetch() for     │                              │
│  │    external URLs (no token)       │                              │
│  └───────────────────────────────────┘                              │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

         ▲                              ▲
         │                              │
         │ Bearer token                 │ No token needed
         │ in Authorization header      │ (public endpoint)
         │                              │
┌────────┴────────┐           ┌─────────┴──────────┐
│  Web UI / CLI   │           │ External Services  │
│                 │           │ (webhook senders)  │
│ Authenticates   │           │                    │
│ via login page  │           │ POST /ext/webhooks │
│ or stored token │           │ /receive/:slug     │
└─────────────────┘           └────────────────────┘
```

## How It Works

### 1. Token Resolution

`AUTH_TOKEN` is resolved on-demand via `dotenvx.get()` from the `.env` file. If `.env.keys` is present, the encrypted value is decrypted; otherwise, the plaintext value is read directly.

The token is resolved **once** at module load time and cached for the process lifetime — not per-request.

### 2. Web UI Authentication

When `AUTH_TOKEN` is set, the frontend presents a login page. The user enters the token, which is validated via `POST /api/auth/validate` and then stored in the browser for subsequent requests (sent as `Authorization: Bearer <token>`).

WebSocket connections authenticate via the `Sec-WebSocket-Protocol` header using the `auth-<token>` sub-protocol convention.

### 3. Skill Script Authentication (Authenticated Fetch)

Skill scripts run inside the agent's sandboxed shell and may need to call internal API endpoints (e.g., to create a webhook, trigger a workflow, or query the wiki). They receive an **authenticated fetch wrapper** via `SkillScriptContext`:

- The wrapper inspects the request URL
- If the URL targets the local server origin (`http://localhost:<port>`), it injects the `Authorization: Bearer <token>` header
- If the URL targets an external host, the request passes through unmodified (no token leaked)

This means:

- Skill scripts **never import or see the raw token**
- The token is injected transparently by the core
- External fetch calls are safe - no credential leakage

### 4. Public Endpoints (No Auth Required)

Some endpoints are intentionally unauthenticated:

| Endpoint | Reason |
| -------- | ------ |
| `GET /health` | Health checks |
| `POST /api/auth/validate` | Login flow |
| `POST /ext/webhooks/receive/:slug` | External webhook delivery (has its own HMAC/bearer auth per-webhook) |
| Static files (`/`, `/assets/...`) | Frontend bundle |

### 5. Webhook Endpoint Security

Webhook receive endpoints use **per-webhook authentication** independent of the system `AUTH_TOKEN`:

- `hmac-sha256` - HMAC signature validation (e.g., GitHub-style `X-Hub-Signature-256`)
- `bearer` - Static token in a configurable header
- `none` - No authentication (for trusted internal sources)

Each webhook's secret is stored in the database, not in environment variables.

## Secrets Management

Palim supports two secret storage modes:

### Plain Mode (default for development)

When no `.env.keys` file is present, secrets are read directly from environment variables (`process.env`). No encryption, no ACL enforcement, no audit logging. This is the recommended mode for getting started:

1. Copy `.env.example` to `.env`
2. Fill in your values as plaintext
3. Done — Palim reads them from `process.env` at runtime

### Encrypted Mode (production)

When `.env.keys` exists in the project root, Palim activates dotenvx encryption:

| File | Contents | Committed |
| ---- | -------- | --------- |
| `.env.example` | Template with all variables documented | ✅ |
| `.env` | Encrypted secrets (tokens, API keys) | ✅ (safe — encrypted) |
| `.env.keys` | Private decryption keys | ❌ (gitignored) |

Boot-time env vars are loaded via `dotenvx.config()` at startup (decrypts `.env` if `.env.keys` is present). Extension secrets are managed by the SecretVault (SQLite-backed, AES-256-GCM) with per-row ACL and audit logging. The agent sandbox has **no direct access** to secrets. Instead, only the authenticated fetch wrapper and extension contexts bridge that gap.

## Threat Model Summary

| Threat | Mitigation |
| ------ | ---------- |
| Unauthorized API access | Bearer token required on all `/api/` and `/ext/` routes |
| Token leakage to external services | Fetch wrapper scopes token injection to server origin only |
| Agent sandbox secret access | Sandbox never receives raw tokens; uses injected fetch |
| Timing attacks on token validation | Constant-time comparison (`timingSafeEqual`) |
| Webhook forgery | Per-webhook HMAC or bearer validation |
| Secret file compromise | Optional ECIES encryption |
| Unauthorized secret reads by extensions | Per-key ACL + audit log in encrypted mode; unrestricted in plain mode |
