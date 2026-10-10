/**
 * Loads an extension's UI translation catalogs from `<dir>/locales/<locale>.json`.
 *
 * Catalogs are nested JSON objects of strings (see `shared/i18n.ts`). Besides
 * free-form keys used by the extension's own pages, reserved keys translate
 * manifest and schema metadata on the client (`nav.<route>`, `pages.<id>.title`,
 * `settings.<prop>.title`, `steps.<type>.label`, ...).
 *
 * Unsupported locales and malformed files are skipped with a warning; loading
 * never fails extension activation.
 *
 * @module
 */

import path from "node:path";
import { isLocale, type Locale, type Messages } from "@shared/i18n";
import { type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { formatValidationErrors } from "@src/utils/validation";
import createLogger from "logging";

const logger = createLogger("ExtensionRegistry");

/** Recursive schema of a message catalog: string leaves, nested objects. */
const MessagesSchema = Type.Recursive((This: TSchema) => Type.Record(Type.String(), Type.Union([Type.String(), This])));

/** Catalogs of one extension, keyed by locale. */
export type ExtensionLocales = Partial<Record<Locale, Messages>>;

/**
 * Reads and validates all catalogs in an extension's `locales/` directory.
 *
 * @param name - Extension name (for log messages)
 * @param dir - Extension directory
 * @returns The valid catalogs keyed by locale (empty when there are none)
 */
export async function loadExtensionLocales(name: string, dir: string): Promise<ExtensionLocales> {
  const localesDir = path.join(dir, "locales");
  const result: ExtensionLocales = {};
  let files: string[];
  try {
    files = await Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: localesDir, onlyFiles: true }));
  } catch {
    return result; // no locales/ directory
  }

  for (const file of files.sort()) {
    const locale = path.basename(file, ".json");
    if (!isLocale(locale)) {
      logger.warn(`Extension "${name}": ignoring catalog locales/${file} (unsupported locale "${locale}")`);
      continue;
    }
    try {
      const data: unknown = await Bun.file(path.join(localesDir, file)).json();
      if (!Value.Check(MessagesSchema, data)) {
        const errors = formatValidationErrors(MessagesSchema, data);
        logger.warn(`Extension "${name}": invalid catalog locales/${file}: ${errors}`);
        continue;
      }
      result[locale] = data as Messages;
    } catch (err) {
      logger.warn(`Extension "${name}": cannot read catalog locales/${file}: ${(err as Error).message}`);
    }
  }
  return result;
}
