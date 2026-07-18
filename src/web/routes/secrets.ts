/**
 * Secret management routes - CRUD operations and audit log for extension secrets.
 *
 * Handles `GET /api/extensions/:name/secrets`, `PUT /api/extensions/:name/secrets`,
 * `DELETE /api/extensions/:name/secrets/:key`, and `GET /api/extensions/:name/secrets/audit`.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionRegistry } from "@src/extensions";
import type { SecretVault } from "@src/secrets/vault";
import { Elysia } from "elysia";

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Valid consumer pattern: exact identity, wildcard suffix, or global wildcard. */
const CONSUMER_PATTERN_RE = /^(\*|[a-z][a-z0-9-]*:[a-z0-9_-]+|[a-z][a-z0-9-]*:\*)$/;

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

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Creates the secret management route group.
 *
 * @param getRegistry - Getter for the extension registry (may be undefined during startup)
 * @param getVault - Getter for the SecretVault instance (may be undefined if no master key)
 * @returns Elysia plugin with secret management routes
 */
export function secretRoutes(
  getRegistry: () => ExtensionRegistry | undefined,
  getVault: () => SecretVault | undefined,
) {
  return new Elysia()
    .get(
      "/api/extensions/:name/secrets",
      ({ params, status }) => {
        const reg = getRegistry();
        if (!reg) return status(503, { error: "Extensions not yet initialized" });

        const vault = getVault();
        if (!vault) return status(503, { error: "Secret vault not available" });

        const { name } = params;
        const info = reg.getLoadedExtensionInfo();
        const ext = info.find((e) => e.name === name);
        if (!ext) return status(404, { error: `Extension "${name}" not found` });
        if (!ext.secretsSchema) return status(404, { error: `Extension "${name}" has no secrets schema` });

        const secrets = vault.listStatus(name, ext.secretsSchema);

        return status(200, {
          schema: ext.secretsSchema,
          secrets,
        });
      },
      {
        params: Type.Object({
          name: Type.String({ minLength: 1, description: "Extension name" }),
        }),
      },
    )
    .put(
      "/api/extensions/:name/secrets",
      async ({ params, body, status }) => {
        const reg = getRegistry();
        if (!reg) return status(503, { error: "Extensions not yet initialized" });

        const vault = getVault();
        if (!vault) return status(503, { error: "Secret vault not available" });

        const { name } = params;
        const info = reg.getLoadedExtensionInfo();
        const ext = info.find((e) => e.name === name);
        if (!ext) return status(404, { error: `Extension "${name}" not found` });
        if (!ext.secretsSchema) return status(404, { error: `Extension "${name}" has no secrets schema` });

        const { secrets, consumers } = body as { secrets: Record<string, string>; consumers?: string[] };

        // Validate all keys are in the schema
        const schemaKeys = new Set(ext.secretsSchema.map((s) => s.key));
        for (const key of Object.keys(secrets)) {
          if (!schemaKeys.has(key)) {
            return status(400, { error: `Unrecognized key: ${key}` });
          }
        }

        // Validate no empty/whitespace values
        for (const [key, value] of Object.entries(secrets)) {
          if (value.trim().length === 0) {
            return status(400, { error: `Empty value for key: ${key}` });
          }
        }

        // Validate consumer patterns if provided
        if (consumers) {
          for (const pattern of consumers) {
            if (!isValidConsumerPattern(pattern)) {
              return status(400, { error: `Invalid consumer pattern: ${pattern}` });
            }
          }
        }

        // Atomic bulk upsert
        await vault.bulkUpsert(name, secrets, consumers);

        // Emit secrets:changed event so the owning extension can react
        reg.getEventBus().dispatch({
          type: "secrets:changed",
          extensionName: name,
          updatedKeys: Object.keys(secrets),
          deletedKeys: [],
        });

        return status(200, { success: true });
      },
      {
        params: Type.Object({
          name: Type.String({ minLength: 1, description: "Extension name" }),
        }),
      },
    )
    .delete(
      "/api/extensions/:name/secrets/:key",
      async ({ params, status }) => {
        const reg = getRegistry();
        if (!reg) return status(503, { error: "Extensions not yet initialized" });

        const vault = getVault();
        if (!vault) return status(503, { error: "Secret vault not available" });

        const { name, key } = params;
        const info = reg.getLoadedExtensionInfo();
        const ext = info.find((e) => e.name === name);
        if (!ext) return status(404, { error: `Extension "${name}" not found` });
        if (!ext.secretsSchema) return status(404, { error: `Extension "${name}" has no secrets schema` });

        const deleted = await vault.remove(name, key, "admin:web");
        if (!deleted) {
          return status(404, { error: "Secret not found" });
        }

        // Emit secrets:changed event so the owning extension can react
        reg.getEventBus().dispatch({
          type: "secrets:changed",
          extensionName: name,
          updatedKeys: [],
          deletedKeys: [key],
        });

        return status(200, { success: true });
      },
      {
        params: Type.Object({
          name: Type.String({ minLength: 1, description: "Extension name" }),
          key: Type.String({ minLength: 1, description: "Secret key" }),
        }),
      },
    )
    .get(
      "/api/extensions/:name/secrets/audit",
      ({ params, status }) => {
        const reg = getRegistry();
        if (!reg) return status(503, { error: "Extensions not yet initialized" });

        const vault = getVault();
        if (!vault) return status(503, { error: "Secret vault not available" });

        const { name } = params;
        const info = reg.getLoadedExtensionInfo();
        const ext = info.find((e) => e.name === name);
        if (!ext) return status(404, { error: `Extension "${name}" not found` });
        if (!ext.secretsSchema) return status(404, { error: `Extension "${name}" has no secrets schema` });

        const entries = vault.getAuditLog(name, 50);

        return status(200, { entries });
      },
      {
        params: Type.Object({
          name: Type.String({ minLength: 1, description: "Extension name" }),
        }),
      },
    );
}
