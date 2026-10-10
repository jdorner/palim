/**
 * Pure (rune-free) part of the core UI i18n: typed message keys, an English
 * translator, and translator delegates for plain TypeScript helpers.
 *
 * Helpers that produce UI text either take a {@link CoreTranslate} parameter
 * defaulting to {@link englishT}, or call {@link translateCore} /
 * {@link translateExtension} / {@link activeFormat}, which delegate to the host
 * store once `i18n.svelte.ts` installs it (English before that and in tests).
 * Either way they stay testable without the Svelte compiler.
 *
 * Uses relative imports because backend tests import frontend helpers (e.g.
 * `templateScope.ts`) without the `$shared` alias.
 *
 * @module
 */

import {
  createFormatters,
  createTranslator,
  type Formatters,
  interpolate,
  type TranslateParams,
} from "../../../shared/i18n";
import en from "../locales/en.json";

/** Plural suffixes stripped from catalog keys (`items_one` is addressed as `items`). */
type PluralSuffix = "zero" | "one" | "two" | "few" | "many" | "other";

/** Dot-joined leaf keys of a nested catalog type, with plural variants collapsed. */
type FlattenKeys<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends string
    ? `${Prefix}${K extends `${infer Base}_${PluralSuffix}` ? Base : K}`
    : FlattenKeys<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/** A valid core UI message key. */
export type CoreKey = FlattenKeys<typeof en>;

/** Translates a core UI key. */
export type CoreTranslate = (key: CoreKey, params?: TranslateParams) => string;

/** The bundled English core catalog. */
export const coreEnglish = en;

let englishImpl: CoreTranslate | undefined;

/** English translator for core keys (default for pure helpers and tests). Built on first use. */
export const englishT: CoreTranslate = (key, params) => {
  const translate = englishImpl ?? createTranslator("en", [en]);
  englishImpl = translate;
  return translate(key, params);
};

/** Translates extension metadata: extension name, catalog key, English fallback, params. */
export type ExtensionTranslate = (extension: string, key: string, fallback: string, params?: TranslateParams) => string;

let coreImpl: CoreTranslate = englishT;
let englishFormat: Formatters | undefined;
let formatImpl: () => Formatters = () => {
  const format = englishFormat ?? createFormatters("en");
  englishFormat = format;
  return format;
};
let extensionImpl: ExtensionTranslate = (_extension, _key, fallback, params) => interpolate(fallback, params);

/**
 * Translates a core key with the active locale. Delegates to the host i18n store
 * once it is installed (see {@link installTranslators}), English before that and
 * in tests. Reactive when called from a template, because the installed
 * implementation reads rune state.
 *
 * @param key - Message key
 * @param params - Interpolation values
 * @returns The translated string
 */
export const translateCore: CoreTranslate = (key, params) => coreImpl(key, params);

/**
 * Translates extension metadata with the active locale (see {@link translateCore}).
 *
 * @param extension - Extension name
 * @param key - Catalog key (e.g. `steps.<type>.label`)
 * @param fallback - English text from the manifest or schema
 * @param params - Interpolation values
 * @returns The translation, or the interpolated fallback
 */
export const translateExtension: ExtensionTranslate = (extension, key, fallback, params) =>
  extensionImpl(extension, key, fallback, params);

/**
 * Locale-aware formatters for the active locale (English before the host store
 * is installed and in tests). Reactive when called from a template.
 *
 * @returns The formatters
 */
export function activeFormat(): Formatters {
  return formatImpl();
}

/**
 * Installs the host store's translators. Called once by `i18n.svelte.ts`.
 *
 * @param core - Core key translator
 * @param extension - Extension metadata translator
 * @param format - Returns the active locale's formatters
 */
export function installTranslators(core: CoreTranslate, extension: ExtensionTranslate, format: () => Formatters): void {
  coreImpl = core;
  extensionImpl = extension;
  formatImpl = format;
}

/**
 * Localized label for a job, workflow run, or step status (`status.<name>`),
 * falling back to the raw status for unknown values.
 *
 * @param status - Status value (e.g. `completed`, `waiting-signal`)
 * @returns The label
 */
export function statusLabel(status: string): string {
  return translateCore(`status.${status}` as CoreKey, { default: status });
}
