# Secrets Management

## Overview

Palim has two layers of secret management that serve different purposes:

1. **Boot-time environment variables** - Infrastructure config loaded once at startup (API keys, server URLs, auth tokens). Managed via `.env` files with optional dotenvx encryption.
2. **SecretVault** - Runtime secret storage for extensions and workflows. SQLite-backed, AES-256-GCM encrypted, with per-row ACL and audit logging. Managed through the web UI.

This document covers the SecretVault system. For boot-time environment variables and API authentication, see [API Security Model](./api-security-model.md).

## Architecture

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                           SecretVault                                   │
│                                                                         │
│  ┌────────────────────────────────────────────┐                         │
│  │           SQLite (secrets_vault)           │                         │
│  │                                            │                         │
│  │  scope | secret_key | encrypted_value | iv │                         │
│  │  ─────   ──────────   ───────────────   ── │                         │
│  │  global   GITEA_TOKEN   <ciphertext>    .. │                         │
│  │  telegram  BOT_TOKEN    <ciphertext>    .. │                         │
│  │  mcp       OPENAI_KEY   <ciphertext>    .. │                         │
│  └────────────────────────────────────────────┘                         │
│                       ▲                                                 │
│                       │                                                 │
│  ┌────────────────────┼──────────────────────────────────────────────┐  │
│  │                    │       Access paths                           │  │
│  │  ┌─────────────┐   │   ┌──────────────┐   ┌───────────────────┐   │  │
│  │  │  Web UI     │───┘   │  Extensions  │   │    Workflows      │   │  │
│  │  │             │       │              │   │                   │   │  │
│  │  │ CRUD via    │       │ ctx.secrets  │   │ {{secret.KEY}}    │   │  │
│  │  │ /api/secrets│       │   .get(key)  │   │ template syntax   │   │  │
│  │  │ /api/ext/   │       │   .set(k,v)  │   │                   │   │  │
│  │  │  :name/     │       │   .resolveAs │   │ resolveByKey()    │   │  │
│  │  │  secrets    │       │              │   │ consumer:         │   │  │
│  │  └─────────────┘       └──────────────┘   │ "workflow:<name>" │   │  │
│  │                                           └───────────────────┘   │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌───────────────────────────┐   ┌────────────────────────────────────┐ │
│  │     EncryptionService     │   │       SecretAuditLogger            │ │
│  │                           │   │                                    │ │
│  │  AES-256-GCM              │   │  Every read/write/delete logged    │ │
│  │  Random 12-byte IV/row    │   │  Consumer identity + result        │ │
│  │  Master key derived once  │   │  Stored in secret_audit_log table  │ │
│  └───────────────────────────┘   └────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

## Enabling the Vault

The vault requires a 32-byte master key. At boot, `deriveMasterKey()` checks two sources in order:

| Source | How it works |
| ------ | ------------ |
| `SECRETS_MASTER_KEY` env var | Decoded as hex or base64. Must yield >= 32 bytes. |
| `.env.keys` file | File content is fed through HKDF-SHA256 with info string `"palim-secret-vault-v1"` to derive 32 bytes. |

If neither source is available or the key is too short, the vault is **not initialized** and:

- All `/api/secrets` and `/api/extensions/:name/secrets` endpoints return HTTP 503 ("Secret vault not available")
- `ctx.secrets.get()` returns `null` with a warning logged
- `ctx.secrets.set()` throws an error
- `{{secret.KEY}}` in workflow templates resolves to the unmodified template string

The startup log makes this explicit:

```text
[INFO]  SecretVault initialized (extension secrets available via web UI)
-- or --
[WARN]  SecretVault disabled: no SECRETS_MASTER_KEY or .env.keys available
```

## Scopes

Secrets are organized by scope (stored per-row):

| Scope | Purpose | Managed via |
| ----- | ------- | ----------- |
| `global` | Shared secrets not bound to any extension. Used by workflows via `{{secret.KEY}}`. | Web UI > Settings > Secrets tab |
| `<extension-name>` (e.g. `telegram`, `mcp`) | Extension-specific secrets declared in `secretsSchema`. | Web UI > Settings > Extensions > gear icon |

## Encryption

Each secret value is encrypted independently using AES-256-GCM:

- **Key**: 256-bit master key (derived once at boot)
- **IV**: 12 random bytes generated per encryption operation
- **Output**: base64-encoded ciphertext (includes the 16-byte GCM authentication tag)
- **Storage**: `encrypted_value` and `iv` columns in the `secrets_vault` table

The Web Crypto API handles all cryptographic operations. Decryption failure (e.g. key rotation without re-encryption) returns `null` and is logged as a denial.

## Access Control (ACL)

Each secret row stores a JSON array of **consumer patterns** in the `acl_consumers` column. When a consumer requests a secret, the vault checks if any pattern matches.

### Pattern syntax

| Pattern | Matches |
| ------- | ------- |
| `*` | Any consumer (global wildcard) |
| `ext:telegram` | Exactly `ext:telegram` |
| `ext:*` | Any consumer starting with `ext:` |
| `workflow:*` | Any workflow |
| `workflow:daily-check` | Only the `daily-check` workflow |

### Consumer identities

Consumers are identified by a prefix indicating their type:

| Identity | Assigned to |
| -------- | ----------- |
| `ext:<name>` | Extensions accessing their own scope via `ctx.secrets.get()` |
| `workflow:<name>` | Workflows resolving `{{secret.KEY}}` templates |
| `admin:web` | Web UI operations (always granted for write/delete) |

### Owner pattern invariant

When an extension stores a secret via `bulkUpsert()`, the pattern `ext:<scope>` is automatically prepended to the ACL. This ensures the owning extension always retains read access. Global secrets (`scope = "global"`) skip this behavior since they have no owning extension.

## Audit Logging

Every access attempt is recorded in the `secret_audit_log` table:

| Field | Description |
| ----- | ----------- |
| `id` | Unique nanoid |
| `secret_name` | Format: `<scope>/<key>` (e.g. `global/GITEA_TOKEN`) |
| `consumer` | The requester's identity (e.g. `workflow:commit-check`) |
| `action` | `read`, `write`, or `delete` |
| `result` | `granted` or `denied` |
| `timestamp` | Epoch milliseconds |
| `reason` | Denial reason (e.g. "ACL denied", "Decryption failed") |

The audit log is queryable per-scope via the API (`GET /api/secrets/audit` for global, `GET /api/extensions/:name/secrets/audit` for extensions).

Security note: when `resolveByKey()` denies a cross-scope lookup, the logged `secret_name` uses `*/<key>` rather than revealing the actual scope. This prevents scope enumeration by unauthorized consumers.

## Consuming Secrets

### From extensions

Extensions access their own secrets through the scoped context:

```typescript
// Read a secret (scoped to ext:<name>)
const token = await ctx.secrets.get("BOT_TOKEN");

// Write a secret (upserts with owner ACL)
await ctx.secrets.set("BOT_TOKEN", "abc123", {
  consumers: ["workflow:*"],  // additional consumers beyond the owner
});

// Cross-scope resolve (for trusted core extensions like workflows)
const value = await ctx.secrets.resolveAs("GITEA_TOKEN", "workflow:daily-check");
```

When the vault is unavailable, `get()` returns `null` and `set()` throws.

### From workflows

Workflow step prompts use the `{{secret.KEY}}` template syntax:

```json5
{
  "slug": "fetch-commits",
  "prompt": [
    "Fetch commits from the API:",
    "web fetch -H \"Authorization: Bearer {{secret.GITEA_API_TOKEN}}\" \"https://git.example.com/api/v1/repos/user/repo/commits\""
  ]
}
```

Resolution uses `resolveByKey()` which searches all scopes for the first row where the workflow's consumer identity (`workflow:<name>`) passes the ACL check. The secret is decrypted only at runtime, never stored in plain text in workflow definitions.

### From the Web UI

The Settings page exposes two secret management interfaces:

- **Secrets tab** (global secrets): Full CRUD for shared secrets with key, value, description, and consumer patterns.
- **Extension settings** (per-extension): Schema-driven forms for secrets declared in an extension's `secretsSchema` manifest field.

## API Endpoints

### Global secrets

| Method | Path | Description |
| ------ | ---- | ----------- |
| `GET` | `/api/secrets` | List all global secrets (metadata only, no values) |
| `PUT` | `/api/secrets` | Upsert one or more global secrets |
| `PATCH` | `/api/secrets/:key` | Update ACL/description without re-encrypting |
| `DELETE` | `/api/secrets/:key` | Remove a global secret |
| `GET` | `/api/secrets/audit` | Recent audit log entries for global scope |

### Extension secrets

| Method | Path | Description |
| ------ | ---- | ----------- |
| `GET` | `/api/extensions/:name/secrets` | List status (set/unset) for schema-declared secrets |
| `PUT` | `/api/extensions/:name/secrets` | Upsert extension secrets (keys validated against schema) |
| `DELETE` | `/api/extensions/:name/secrets/:key` | Remove an extension secret |
| `GET` | `/api/extensions/:name/secrets/audit` | Recent audit log for the extension's scope |

All endpoints return HTTP 503 with `{ "error": "Secret vault not available" }` when the vault is not initialized.

## Database Schema

The vault uses two SQLite tables (created via Drizzle migrations):

**`secrets_vault`** - Encrypted secret storage:

- Composite unique constraint on `(scope, secret_key)`
- Index on `scope` for efficient per-scope queries
- `key_version` column reserved for future key rotation support

**`secret_audit_log`** - Append-only access log:

- Indexes on `timestamp` and `secret_name` for efficient querying
- No automatic purging (grows indefinitely)

## Key Format Requirements

Global secret keys must match `^[A-Z][A-Z0-9_]{0,63}$` (UPPER_SNAKE_CASE, 1-64 characters). Extension secret keys are validated against the extension's declared `secretsSchema`.

## Troubleshooting

| Symptom | Cause | Fix |
| ------- | ----- | --- |
| "Secret vault not available" (503) | No master key configured | Set `SECRETS_MASTER_KEY` or ensure `.env.keys` exists |
| `SECRETS_MASTER_KEY is too short` in logs | Key decodes to < 32 bytes | Use a 64-character hex string or 44-character base64 string |
| Extension `getSecret()` returns null | Key not stored, or vault disabled | Check vault status in logs; store the secret via web UI |
| Workflow `{{secret.KEY}}` not resolved | ACL denies `workflow:<name>`, or vault disabled | Add `workflow:*` (or specific identity) to the secret's consumers |
| "Decryption failed" in audit log | Master key changed without re-encrypting secrets | Re-store affected secrets via the web UI with the current key |
