/**
 * Extension discovery and validation.
 *
 * Pure functions for scanning extension directories and validating that
 * discovered modules conform to the {@link Extension} interface contract.
 * Extracted from ExtensionRegistry to keep discovery logic testable in
 * isolation without needing the full registry lifecycle.
 *
 * @module
 */

import { Value } from "@sinclair/typebox/value";
import { formatValidationErrors } from "@src/utils/validation";
import createLogger from "logging";
import { type Extension, ExtensionManifestSchema } from "../types";

const logger = createLogger("ExtensionRegistry");

/** Top-level directories next to extensions that hold SDK modules, not extensions (`ui/` is `@ext/ui`). */
const NON_EXTENSION_DIRS = new Set(["ui"]);

/**
 * Scan one or more extension directories for modules (subdirectories
 * containing an `index.ts`). Supports both top-level extensions and
 * extensions nested under `core/`.
 *
 * Each discovered module is dynamically imported and validated. Invalid
 * modules are logged and skipped.
 *
 * @param extensionDirs - Directories to scan for extensions
 * @returns Array of valid Extension objects
 */
export async function discoverExtensions(extensionDirs: string[]): Promise<Extension[]> {
  const extensions: Extension[] = [];
  const patterns = ["*/index.ts", "core/*/index.ts"];

  for (const dir of extensionDirs) {
    try {
      for (const pattern of patterns) {
        const glob = new Bun.Glob(pattern);
        for (const entry of glob.scanSync({ cwd: dir, absolute: false })) {
          if (NON_EXTENSION_DIRS.has(entry.split("/")[0] ?? "")) continue;
          const modulePath = `${dir}/${entry}`;
          const ext = await loadExtensionModule(modulePath);
          if (ext) extensions.push(ext);
        }
      }
    } catch {
      logger.warn(`Extensions directory not found or unreadable: ${dir}`);
    }
  }

  return extensions;
}

/** Module path each discovered extension object was imported from. */
const discoveredModulePaths = new WeakMap<Extension, string>();

/**
 * Returns the module path an extension object was discovered at.
 *
 * @param ext - An extension returned by {@link discoverExtensions} or {@link loadExtensionModule}
 * @returns Absolute path to its index.ts, or undefined for extensions not loaded through discovery
 */
export function getDiscoveredModulePath(ext: Extension): string | undefined {
  return discoveredModulePaths.get(ext);
}

/**
 * Dynamically import a single extension module and validate its exports.
 *
 * @param modulePath - Absolute path to the extension's index.ts
 * @returns The validated Extension object, or null if import/validation failed
 */
export async function loadExtensionModule(modulePath: string): Promise<Extension | null> {
  try {
    const mod = await import(modulePath);
    const ext: Extension = mod.default ?? mod;

    if (!validateExtension(ext, modulePath)) {
      return null;
    }

    discoveredModulePaths.set(ext, modulePath);
    return ext;
  } catch (err) {
    logger.error(`Failed to import extension module at ${modulePath}:`, err);
    return null;
  }
}

/**
 * Validate that a module export satisfies the {@link Extension} interface.
 *
 * Checks:
 * - TypeBox schema conformance for the manifest
 * - `settingsSchema` shape (must be a TObject with `type: "object"` and `properties`)
 * - `secretsSchema` for duplicate key names
 * - `ui.navigation` for duplicate routes
 * - `ui.pages` for duplicate ids, and `/ext-page/...` navigation routes for valid targets
 * - Presence of `initialize()` and `shutdown()` lifecycle methods
 *
 * @param ext - The candidate object to validate
 * @param modulePath - Path used for error messages
 * @returns `true` if the object is a valid Extension
 */
export function validateExtension(ext: unknown, modulePath: string): ext is Extension {
  if (!ext || typeof ext !== "object") {
    logger.error(`Extension at ${modulePath}: export is not an object`);
    return false;
  }

  const candidate = ext as Record<string, unknown>;

  // Validate manifest with TypeBox
  if (!candidate.manifest || !Value.Check(ExtensionManifestSchema, candidate.manifest)) {
    const errorDetail = candidate.manifest
      ? formatValidationErrors(ExtensionManifestSchema, candidate.manifest)
      : "missing manifest";
    logger.error(`Extension at ${modulePath}: invalid manifest - ${errorDetail}`);
    return false;
  }

  // Validate settingsSchema if present (must be a TObject with type "object" and properties)
  const manifest = candidate.manifest as Record<string, unknown>;
  if (manifest.settingsSchema != null) {
    const settingsSchema = manifest.settingsSchema as Record<string, unknown>;
    if (
      settingsSchema.type !== "object" ||
      typeof settingsSchema.properties !== "object" ||
      settingsSchema.properties === null
    ) {
      logger.error(
        `Extension at ${modulePath}: settingsSchema must be a TypeBox Type.Object() (got type="${settingsSchema.type}")`,
      );
      return false;
    }
  }

  // Validate secretsSchema for duplicate key names (TypeBox catches structure, this catches duplicates)
  if (manifest.secretsSchema != null) {
    const secretsSchema = manifest.secretsSchema as Array<{ key: string }>;
    const keyNames = new Set<string>();
    const duplicates: string[] = [];
    for (const entry of secretsSchema) {
      if (keyNames.has(entry.key)) {
        duplicates.push(entry.key);
      }
      keyNames.add(entry.key);
    }
    if (duplicates.length > 0) {
      logger.warn(
        `Extension at ${modulePath}: secretsSchema has duplicate key names: ${duplicates.join(", ")} - skipping secrets schema`,
      );
      manifest.secretsSchema = undefined;
    }
  }

  // Check for duplicate routes within the manifest's ui.navigation array
  const ui = manifest.ui as { navigation?: Array<{ route: string }>; pages?: Array<{ id: string }> } | undefined;
  if (ui?.navigation && ui.navigation.length > 0) {
    const routes = new Set<string>();
    for (const entry of ui.navigation) {
      if (routes.has(entry.route)) {
        logger.error(`Extension at ${modulePath}: duplicate route "${entry.route}" in ui.navigation`);
        return false;
      }
      routes.add(entry.route);
    }
  }

  // Page ids must be unique, and navigation into extension pages must target
  // one of this extension's own declared pages.
  if (!validateUiPages(manifest.name as string, ui, modulePath)) return false;

  if (typeof candidate.initialize !== "function") {
    logger.error(`Extension at ${modulePath}: missing initialize() method`);
    return false;
  }

  if (typeof candidate.shutdown !== "function") {
    logger.error(`Extension at ${modulePath}: missing shutdown() method`);
    return false;
  }

  return true;
}

/**
 * Validates an extension's declared UI pages against its navigation entries.
 *
 * - Page ids must be unique.
 * - A navigation route under `/ext-page/` must name this extension, and the
 *   extension must declare pages. When the route also names a page
 *   (`/ext-page/<name>/<page>`), that page must be declared.
 *
 * @param name - Extension name from the manifest
 * @param ui - The manifest's `ui` field
 * @param modulePath - Path used for error messages
 * @returns `true` when valid
 */
export function validateUiPages(
  name: string,
  ui: { navigation?: Array<{ route: string }>; pages?: Array<{ id: string }> } | undefined,
  modulePath: string,
): boolean {
  const pageIds = new Set<string>();
  for (const page of ui?.pages ?? []) {
    if (pageIds.has(page.id)) {
      logger.error(`Extension at ${modulePath}: duplicate page id "${page.id}" in ui.pages`);
      return false;
    }
    pageIds.add(page.id);
  }

  for (const entry of ui?.navigation ?? []) {
    const match = /^\/ext-page\/([^/]+)(?:\/([^/]+))?/.exec(entry.route);
    if (!match) continue;
    const [, target, pageId] = match;
    if (target !== name) {
      logger.error(
        `Extension at ${modulePath}: navigation route "${entry.route}" points at another extension's pages (expected /ext-page/${name}/...)`,
      );
      return false;
    }
    if (pageIds.size === 0) {
      logger.error(`Extension at ${modulePath}: navigation route "${entry.route}" requires ui.pages to be declared`);
      return false;
    }
    if (pageId && !pageIds.has(pageId)) {
      logger.error(`Extension at ${modulePath}: navigation route "${entry.route}" names undeclared page "${pageId}"`);
      return false;
    }
  }
  return true;
}
