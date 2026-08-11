/**
 * Extension configuration resolver.
 *
 * Encapsulates the layered config lookup (env var > SQLite > schema default > caller default)
 * and the settings cache lifecycle. Extracted from extensionContext.ts so the resolution
 * logic is independently testable and reusable.
 *
 * @module
 */

import { schema } from "@src/db";
import { eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { ConfigValue } from "../types";

/**
 * Dependencies for creating a config resolver instance.
 */
export interface ConfigResolverDeps {
  /** The extension name (used to derive env var prefix). */
  extensionName: string;
  /** The shared Drizzle database instance. */
  database: BunSQLiteDatabase<Record<string, unknown>>;
  /** The extension's settingsSchema (TypeBox TObject), if declared. */
  settingsSchema?: Record<string, unknown>;
}

/**
 * Creates a scoped config resolver for a single extension.
 *
 * Provides a `get(key, default?)` method with layered precedence:
 * 1. Environment variable `EXT_{NAME}_{KEY}`
 * 2. SQLite persisted settings (cached in memory)
 * 3. Schema default value
 * 4. Caller-provided default
 *
 * Also exposes `invalidateCache()` for reacting to settings:changed events.
 *
 * @param deps - Extension identity, database, and optional schema
 * @returns Object with `get` and `invalidateCache` methods
 */
export function createConfigResolver(deps: ConfigResolverDeps) {
  const { extensionName, database, settingsSchema } = deps;

  /** Cached settings object from SQLite (null = not yet loaded). */
  let settingsCache: Record<string, unknown> | null = null;

  /**
   * Load persisted settings from SQLite into the cache.
   * Returns the cached object (may be empty `{}`).
   */
  function loadSettingsCache(): Record<string, unknown> {
    if (settingsCache !== null) return settingsCache;
    try {
      const row = database
        .select({ config: schema.extensionSettings.config })
        .from(schema.extensionSettings)
        .where(eq(schema.extensionSettings.name, extensionName))
        .get();
      settingsCache = row?.config ? (JSON.parse(row.config) as Record<string, unknown>) : {};
    } catch {
      settingsCache = {};
    }
    return settingsCache;
  }

  /** Invalidate the settings cache so the next read fetches from SQLite. */
  function invalidateCache(): void {
    settingsCache = null;
  }

  /**
   * Read a configuration value for this extension by key.
   * Precedence: env var > SQLite persisted value > schema default > caller default.
   *
   * Values are coerced from the raw env-var string:
   * `"true"`/`"false"` -> boolean, numeric strings -> number,
   * JSON-shaped strings -> parsed object/array, everything else -> string.
   *
   * @param key - The configuration key (UPPER_SNAKE_CASE).
   * @param defaultValue - Returned when no source provides a value.
   * @returns The resolved value, or `undefined`.
   */
  function get(key: string, defaultValue?: ConfigValue): ConfigValue | undefined {
    // 1. Check environment variable (highest precedence)
    const envKey = `EXT_${extensionName.toUpperCase().replace(/-/g, "_")}_${key}`;
    const val = process.env[envKey];
    if (typeof val !== "undefined") {
      return coerceEnvValue(val, defaultValue);
    }

    // 2. Check SQLite persisted settings
    const camelKey = envKeyToCamelCase(key);
    const cached = loadSettingsCache();
    if (camelKey in cached) {
      return cached[camelKey] as ConfigValue;
    }

    // 3. Check schema default
    if (settingsSchema) {
      const properties = (settingsSchema as Record<string, unknown>).properties as
        | Record<string, Record<string, unknown>>
        | undefined;
      if (properties?.[camelKey]?.default !== undefined) {
        return properties[camelKey].default as ConfigValue;
      }
    }

    // 4. Caller-provided default
    return defaultValue;
  }

  return { get, invalidateCache };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Coerce a raw env-var string into a typed ConfigValue.
 *
 * @param val - The raw string from process.env
 * @param defaultValue - Fallback if JSON parsing fails
 * @returns The coerced value
 */
function coerceEnvValue(val: string, defaultValue?: ConfigValue): ConfigValue | undefined {
  try {
    if (val.toLowerCase() === "true") return true;
    if (val.toLowerCase() === "false") return false;

    const num = Number(val);
    if (!Number.isNaN(num) && val.trim() !== "") return num;

    if (val.startsWith("{") || val.startsWith("[")) {
      return JSON.parse(val) as Record<string, unknown> | unknown[];
    }
  } catch {
    return defaultValue;
  }

  return val;
}

/**
 * Convert an UPPER_SNAKE_CASE key (e.g. "MAX_PAYLOAD_SIZE") to camelCase
 * (e.g. "maxPayloadSize") for matching against schema property names.
 *
 * @param key - The UPPER_SNAKE_CASE key
 * @returns The camelCase equivalent
 */
function envKeyToCamelCase(key: string): string {
  return key.toLowerCase().replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}
