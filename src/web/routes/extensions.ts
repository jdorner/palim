/**
 * Extension management routes - list, toggle, and settings management.
 *
 * Handles `GET /api/extensions`, `PUT /api/extensions/:name`,
 * `GET /api/extensions/:name/settings`, and `PUT /api/extensions/:name/settings`.
 */

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { getDb, schema } from "@src/db";
import type { ExtensionRegistry } from "@src/extensions";
import { mainLogger as log } from "@src/utils/logger";
import { enrichSchemaWithDynamicItems } from "@src/web/dynamicItemProviders";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";

/**
 * Creates the extension management route group.
 *
 * @param getRegistry - Getter for the extension registry (may be undefined during startup)
 * @returns Elysia plugin with extension routes
 */
export function extensionRoutes(getRegistry: () => ExtensionRegistry | undefined) {
  return new Elysia()
    .get("/api/extensions", ({ status }) => {
      const reg = getRegistry();
      if (!reg) return status(503, { error: "Extensions not yet initialized" });
      return status(200, reg.getLoadedExtensionInfo());
    })
    .put(
      "/api/extensions/:name",
      async ({ params, body, status }) => {
        const reg = getRegistry();
        if (!reg) return status(503, { error: "Extensions not yet initialized" });

        const { name } = params;
        const info = reg.getLoadedExtensionInfo();
        const ext = info.find((e) => e.name === name);
        if (!ext) {
          return status(404, { error: `Extension "${name}" not found` });
        }

        // Core extensions cannot be disabled
        if (ext.core && !body.enabled) {
          return status(403, { error: `Core extension "${name}" cannot be disabled` });
        }

        const { enabled } = body;
        const db = getDb();

        if (enabled) {
          // Enable: activate first, persist DB state only on success
          try {
            await reg.activate(name);
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            log.error(`Failed to activate extension "${name}":`, errorMsg);
            return status(422, { error: errorMsg });
          }

          db.insert(schema.extensionSettings)
            .values({ name, enabled: true, updatedAt: Date.now() })
            .onConflictDoUpdate({
              target: schema.extensionSettings.name,
              set: { enabled: true, updatedAt: Date.now() },
            })
            .run();

          const updatedInfo = reg.getLoadedExtensionInfo();
          const updated = updatedInfo.find((e) => e.name === name);
          return status(200, updated ?? { ...ext, enabled: true });
        }

        // Disable: persist DB state first, then deactivate
        db.insert(schema.extensionSettings)
          .values({ name, enabled: false, updatedAt: Date.now() })
          .onConflictDoUpdate({
            target: schema.extensionSettings.name,
            set: { enabled: false, updatedAt: Date.now() },
          })
          .run();

        try {
          await reg.deactivate(name);
        } catch (err) {
          log.error(`Error during deactivation of extension "${name}":`, err);
          // Deactivation errors are logged but response is still 200
        }

        const updatedInfo = reg.getLoadedExtensionInfo();
        const updated = updatedInfo.find((e) => e.name === name);
        return status(200, updated ?? { ...ext, enabled: false });
      },
      {
        params: Type.Object({
          name: Type.String({ minLength: 1, description: "Extension name" }),
        }),
        body: Type.Object({
          enabled: Type.Boolean({ description: "Whether the extension should be visible to the agent" }),
        }),
      },
    )
    .get(
      "/api/extensions/:name/settings",
      ({ params, status }) => {
        const reg = getRegistry();
        if (!reg) return status(503, { error: "Extensions not yet initialized" });

        const { name } = params;
        const info = reg.getLoadedExtensionInfo();
        const ext = info.find((e) => e.name === name);
        if (!ext) return status(404, { error: `Extension "${name}" not found` });
        if (!ext.settingsSchema) return status(404, { error: `Extension "${name}" has no settings schema` });

        // Load persisted values from SQLite
        const db = getDb();
        const row = db
          .select({ config: schema.extensionSettings.config })
          .from(schema.extensionSettings)
          .where(eq(schema.extensionSettings.name, name))
          .get();

        let values: Record<string, unknown> = {};
        if (row?.config) {
          try {
            values = JSON.parse(row.config) as Record<string, unknown>;
          } catch {
            values = {};
          }
        }

        // Enrich schema with dynamically resolved items before sending to frontend
        const enrichedSchema = enrichSchemaWithDynamicItems(ext.settingsSchema as Record<string, unknown>);

        // Mask sensitive fields
        const properties = (enrichedSchema as Record<string, unknown>).properties as
          | Record<string, Record<string, unknown>>
          | undefined;
        if (properties) {
          for (const [key, prop] of Object.entries(properties)) {
            if (prop.sensitive === true && key in values && values[key] !== "") {
              values[key] = "***";
            }
          }
        }

        return status(200, { schema: enrichedSchema, values });
      },
      {
        params: Type.Object({
          name: Type.String({ minLength: 1, description: "Extension name" }),
        }),
      },
    )
    .put(
      "/api/extensions/:name/settings",
      ({ params, body, status }) => {
        const reg = getRegistry();
        if (!reg) return status(503, { error: "Extensions not yet initialized" });

        const { name } = params;
        const info = reg.getLoadedExtensionInfo();
        const ext = info.find((e) => e.name === name);
        if (!ext) return status(404, { error: `Extension "${name}" not found` });
        if (!ext.settingsSchema) return status(404, { error: `Extension "${name}" has no settings schema` });

        const settingsSchema = ext.settingsSchema as Record<string, unknown>;
        const properties = settingsSchema.properties as Record<string, Record<string, unknown>> | undefined;

        // Load existing values for sensitive field preservation
        const db = getDb();
        const existingRow = db
          .select({ config: schema.extensionSettings.config })
          .from(schema.extensionSettings)
          .where(eq(schema.extensionSettings.name, name))
          .get();

        let existingValues: Record<string, unknown> = {};
        if (existingRow?.config) {
          try {
            existingValues = JSON.parse(existingRow.config) as Record<string, unknown>;
          } catch {
            existingValues = {};
          }
        }

        // Preserve sensitive fields that are submitted as "***"
        const merged = { ...(body as Record<string, unknown>) };
        if (properties) {
          for (const [key, prop] of Object.entries(properties)) {
            if (prop.sensitive === true && merged[key] === "***" && key in existingValues) {
              merged[key] = existingValues[key];
            }
          }
        }

        // Validate against schema
        if (!Value.Check(settingsSchema as any, merged)) {
          const errors = [...Value.Errors(settingsSchema as any, merged)];
          const messages = errors.map((e) => `${e.path}: ${e.message}`).join("; ");
          return status(400, { error: `Validation failed: ${messages}` });
        }

        // Persist to SQLite
        db.insert(schema.extensionSettings)
          .values({ name, config: JSON.stringify(merged), updatedAt: Date.now() })
          .onConflictDoUpdate({
            target: schema.extensionSettings.name,
            set: { config: JSON.stringify(merged), updatedAt: Date.now() },
          })
          .run();

        // Emit settings:changed event
        reg.getEventBus().dispatch({
          type: "settings:changed",
          extensionName: name,
          values: merged,
        });

        log.info(`Settings updated for extension "${name}"`);
        return status(200, { values: merged });
      },
      {
        params: Type.Object({
          name: Type.String({ minLength: 1, description: "Extension name" }),
        }),
      },
    );
}
