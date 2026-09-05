/**
 * Dynamic item provider registry for extension settings schemas.
 *
 * Extensions can annotate array properties in their settings schema with a
 * `dynamicItems` key that names a registered provider. When the settings API
 * serves the schema to the frontend, it resolves each `dynamicItems` reference
 * and injects the result into `availableItems`, keeping the frontend unchanged.
 *
 * @example
 * ```ts
 * // In an extension's settingsSchema:
 * monitoredQueues: Type.Array(Type.String(), {
 *   availableItems: ["agents", "chat"],   // static fallback
 *   dynamicItems: "all-queue-names",  // resolved at request time
 * })
 * ```
 *
 * @module
 */

import { mainLogger as log } from "@src/utils/logger";

/** A function that returns the current set of available items for a schema property. */
export type DynamicItemProvider = () => string[];

/**
 * A function that returns the current resolved `default` for a scalar schema
 * property (e.g. a runtime-discovered path). Returning an empty string leaves
 * the field effectively unset (the form shows a blank editable field).
 */
export type DynamicDefaultProvider = () => string;

/** Internal registry mapping provider names to their resolver functions. */
const providers = new Map<string, DynamicItemProvider>();

/** Internal registry mapping provider names to scalar-default resolvers. */
const defaultProviders = new Map<string, DynamicDefaultProvider>();

/**
 * Register a named dynamic item provider.
 *
 * @param name - Unique provider name referenced by `dynamicItems` in schemas
 * @param fn - Function that returns the current available items
 * @throws If a provider with the same name is already registered
 */
export function registerDynamicItemProvider(name: string, fn: DynamicItemProvider): void {
  if (providers.has(name)) {
    log.warn(`Dynamic item provider "${name}" is being replaced`);
  }
  providers.set(name, fn);
}

/**
 * Resolve a named provider to its current items.
 *
 * @param name - The provider name to look up
 * @returns The resolved items array, or `null` if the provider is not registered
 */
export function resolveDynamicItems(name: string): string[] | null {
  const fn = providers.get(name);
  if (!fn) {
    log.debug(`Dynamic item provider "${name}" not found`);
    return null;
  }
  try {
    return fn();
  } catch (err) {
    log.error(`Dynamic item provider "${name}" threw an error:`, err);
    return null;
  }
}

/**
 * Register a named dynamic default provider.
 *
 * When a settings schema property declares `dynamicDefault: "<providerName>"`,
 * the named provider is invoked at request time and its return value replaces
 * the property's `default`. Use this to surface a runtime-discovered value
 * (e.g. an auto-detected binary path) as the field's default while keeping the
 * field editable.
 *
 * @param name - Unique provider name referenced by `dynamicDefault` in schemas
 * @param fn - Function that returns the current default value
 */
export function registerDynamicDefaultProvider(name: string, fn: DynamicDefaultProvider): void {
  if (defaultProviders.has(name)) {
    log.warn(`Dynamic default provider "${name}" is being replaced`);
  }
  defaultProviders.set(name, fn);
}

/**
 * Resolve a named default provider to its current value.
 *
 * @param name - The provider name to look up
 * @returns The resolved default string, or `null` if the provider is not registered or fails
 */
export function resolveDynamicDefault(name: string): string | null {
  const fn = defaultProviders.get(name);
  if (!fn) {
    log.debug(`Dynamic default provider "${name}" not found`);
    return null;
  }
  try {
    return fn();
  } catch (err) {
    log.error(`Dynamic default provider "${name}" threw an error:`, err);
    return null;
  }
}

/**
 * Enrich a JSON Schema object by resolving all `dynamicItems` references
 * in its properties. Mutates a deep clone of the schema (the original is untouched).
 *
 * For each property that declares `dynamicItems: "<providerName>"`, the named
 * provider is invoked and its result replaces `availableItems`. If the provider
 * is not registered or fails, the existing static `availableItems` is preserved.
 *
 * @param schema - The raw JSON Schema object (TypeBox output)
 * @returns A new schema object with `availableItems` populated from providers
 */
export function enrichSchemaWithDynamicItems(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return schema;

  // Check if any property has a dynamic reference (items or default) before cloning
  let hasDynamic = false;
  for (const prop of Object.values(properties)) {
    if (typeof prop.dynamicItems === "string" || typeof prop.dynamicDefault === "string") {
      hasDynamic = true;
      break;
    }
  }
  if (!hasDynamic) return schema;

  // Deep clone to avoid mutating the original schema
  const enriched = structuredClone(schema);
  const enrichedProperties = enriched.properties as Record<string, Record<string, unknown>>;

  for (const [_key, prop] of Object.entries(enrichedProperties)) {
    // Array properties: resolve availableItems from an item provider.
    const providerName = prop.dynamicItems;
    if (typeof providerName === "string") {
      const items = resolveDynamicItems(providerName);
      if (items !== null) {
        prop.availableItems = items;
      }
      // If resolution failed, leave the existing static availableItems untouched
    }

    // Scalar properties: resolve `default` from a default provider so a
    // runtime-discovered value (e.g. an auto-detected path) is shown in the
    // form while remaining editable. A null/empty result leaves the existing
    // static default untouched.
    const defaultProviderName = prop.dynamicDefault;
    if (typeof defaultProviderName === "string") {
      const resolved = resolveDynamicDefault(defaultProviderName);
      if (resolved !== null && resolved !== "") {
        prop.default = resolved;
      }
    }
  }

  return enriched;
}

/**
 * Remove all registered providers (item and default). Useful for testing.
 */
export function clearDynamicItemProviders(): void {
  providers.clear();
  defaultProviders.clear();
}
