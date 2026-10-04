/**
 * Global secret management routes - CRUD operations and audit log for
 * non-extension secrets stored under the "global" scope.
 *
 * These secrets are not bound to any extension and are typically used by
 * workflow templates via `{{secret.KEY}}` syntax.
 *
 * Handles:
 * - `GET /api/secrets` - List all global secrets (metadata only, no plaintext)
 * - `POST /api/secrets` - Create global secrets (409 if a key already exists)
 * - `PUT /api/secrets` - Upsert global secrets with ACL and descriptions
 * - `DELETE /api/secrets/:key` - Remove a single global secret
 * - `GET /api/secrets/audit` - Audit log for global scope
 */

import { type Static, Type } from "@sinclair/typebox";
import { SecretVault } from "@src/secrets/vault";
import { Elysia } from "elysia";

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Valid consumer pattern: exact identity, wildcard suffix, or global wildcard. */
const CONSUMER_PATTERN_RE = /^(\*|[a-z][a-z0-9-]*:[a-z0-9_-]+|[a-z][a-z0-9-]*:\*)$/;

/** Valid secret key: uppercase letters, digits, and underscores. */
const SECRET_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Validates that a consumer pattern string matches one of the allowed formats:
 * - Global wildcard: `*`
 * - Exact identity: `prefix:name` (e.g. `ext:telegram`, `workflow:daily`)
 * - Wildcard suffix: `prefix:*` (e.g. `ext:*`, `workflow:*`)
 *
 * @param pattern - The consumer pattern to validate
 * @returns True if the pattern is valid
 */
function isValidConsumerPattern(pattern: string): boolean {
  return CONSUMER_PATTERN_RE.test(pattern);
}

/** Request body schema shared by `POST` and `PUT /api/secrets`. */
const WriteBody = Type.Object({
  secrets: Type.Record(Type.String(), Type.String(), { description: "Key-value pairs to store" }),
  consumers: Type.Array(Type.String(), { description: "Consumer patterns for ACL" }),
  descriptions: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Per-key descriptions" })),
});

/**
 * Validates a create/upsert body beyond its shape: key format, non-empty
 * values, consumer patterns, and description keys.
 *
 * @param body - The shape-checked request body
 * @returns An error message, or null when the body is valid
 */
function validateWriteBody({ secrets, consumers, descriptions }: Static<typeof WriteBody>): string | null {
  const keys = Object.keys(secrets);
  if (keys.length === 0) return "No secrets provided";

  for (const key of keys) {
    if (!SECRET_KEY_RE.test(key)) return `Invalid key format: "${key}" (must be UPPER_SNAKE_CASE, 1-64 chars)`;
  }
  for (const [key, value] of Object.entries(secrets)) {
    if (value.trim().length === 0) return `Empty value for key: ${key}`;
  }

  // Consumers are required for global secrets
  if (consumers.length === 0) return "At least one consumer pattern is required for global secrets";
  for (const pattern of consumers) {
    if (!isValidConsumerPattern(pattern)) return `Invalid consumer pattern: ${pattern}`;
  }

  if (descriptions) {
    for (const key of Object.keys(descriptions)) {
      if (!keys.includes(key)) return `Description for unknown key: ${key}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Creates the global secret management route group.
 *
 * @param getVault - Getter for the SecretVault instance (may be undefined if no master key)
 * @returns Elysia plugin with global secret management routes
 */
export function globalSecretRoutes(getVault: () => SecretVault | undefined) {
  return new Elysia()
    .get("/api/secrets", ({ status }) => {
      const vault = getVault();
      if (!vault) return status(503, { error: "Secret vault not available" });

      const entries = vault.listGlobal();
      return status(200, { secrets: entries });
    })
    .post(
      "/api/secrets",
      async ({ body, status }) => {
        const vault = getVault();
        if (!vault) return status(503, { error: "Secret vault not available" });

        const error = validateWriteBody(body);
        if (error) return status(400, { error });

        const existing = await vault.createGlobal(body.secrets, body.consumers, body.descriptions);
        if (existing.length > 0) {
          return status(409, { error: `Secret already exists: ${existing.join(", ")}`, existing });
        }
        return status(201, { success: true });
      },
      { body: WriteBody },
    )
    .put(
      "/api/secrets",
      async ({ body, status }) => {
        const vault = getVault();
        if (!vault) return status(503, { error: "Secret vault not available" });

        const error = validateWriteBody(body);
        if (error) return status(400, { error });

        await vault.upsertGlobal(body.secrets, body.consumers, body.descriptions);
        return status(200, { success: true });
      },
      { body: WriteBody },
    )
    .delete(
      "/api/secrets/:key",
      async ({ params, status }) => {
        const vault = getVault();
        if (!vault) return status(503, { error: "Secret vault not available" });

        const { key } = params;
        const deleted = await vault.removeGlobal(key);
        if (!deleted) {
          return status(404, { error: "Secret not found" });
        }

        return status(200, { success: true });
      },
      {
        params: Type.Object({
          key: Type.String({ minLength: 1, description: "Secret key to delete" }),
        }),
      },
    )
    .patch(
      "/api/secrets/:key",
      ({ params, body, status }) => {
        const vault = getVault();
        if (!vault) return status(503, { error: "Secret vault not available" });

        const { key } = params;
        const { consumers, description } = body as {
          consumers: string[];
          description?: string | null;
        };

        // Validate consumers
        if (!consumers || consumers.length === 0) {
          return status(400, { error: "At least one consumer pattern is required" });
        }
        for (const pattern of consumers) {
          if (!isValidConsumerPattern(pattern)) {
            return status(400, { error: `Invalid consumer pattern: ${pattern}` });
          }
        }

        const updated = vault.updateGlobalMeta(key, consumers, description);
        if (!updated) {
          return status(404, { error: "Secret not found" });
        }

        return status(200, { success: true });
      },
      {
        params: Type.Object({
          key: Type.String({ minLength: 1, description: "Secret key to update" }),
        }),
        body: Type.Object({
          consumers: Type.Array(Type.String(), { description: "New consumer patterns for ACL" }),
          description: Type.Optional(
            Type.Union([Type.String(), Type.Null()], { description: "Updated description (null to clear)" }),
          ),
        }),
      },
    )
    .get("/api/secrets/audit", ({ status }) => {
      const vault = getVault();
      if (!vault) return status(503, { error: "Secret vault not available" });

      const entries = vault.getAuditLog(SecretVault.GLOBAL_SCOPE, 50);
      return status(200, { entries });
    });
}
