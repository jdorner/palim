/**
 * Internationalization runtime shared by the host app, extension pages, and the backend.
 *
 * Messages are nested JSON catalogs, addressed by dot-separated keys
 * (`{ chat: { send: "Send" } }` → `"chat.send"`). Strings support `{name}`
 * interpolation; plurals use i18next-style key suffixes (`items_one`,
 * `items_other`, ...) selected by `Intl.PluralRules` when a numeric `count`
 * parameter is given; `{count}` is then rendered with the locale's number
 * format (`1,234` / `1.234`). English is the source language and the fallback
 * for missing keys.
 *
 * Pure and dependency-free: safe to import from backend, frontend, and the
 * extension UI kit (each extension bundle gets its own copy, which is fine
 * because this module holds no state).
 *
 * @module
 */

/** Locales the UI ships translations for. The first entry is the fallback. */
export const SUPPORTED_LOCALES = ["en", "de"] as const;

/** A supported UI locale. */
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** The source and fallback locale. */
export const FALLBACK_LOCALE: Locale = "en";

/** Native display names of the supported locales (for language pickers). */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  de: "Deutsch",
};

/** A nested message catalog. */
export interface Messages {
  [key: string]: string | Messages;
}

/** Interpolation parameters. `count` also selects the plural form. */
export type TranslateParams = Record<string, string | number | boolean | null | undefined> & {
  /** Selects the plural form (`<key>_one`, `<key>_other`, ...). */
  count?: number;
  /** Returned (interpolated) when the key is missing in every catalog. */
  default?: string;
};

/**
 * Translates a key to the active locale.
 *
 * @param key - Dot-separated message key
 * @param params - Interpolation values; `count` selects the plural form, `default` is the missing-key fallback
 * @returns The translated string, the interpolated `default`, or the key itself when missing
 */
export type Translate = (key: string, params?: TranslateParams) => string;

/**
 * Checks whether a value is a supported locale.
 *
 * @param value - Candidate value
 * @returns True for a supported locale
 */
export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Picks the UI locale: the explicit preference when supported, otherwise the
 * first supported language from the browser list (matching by primary subtag,
 * so `de-AT` selects `de`), otherwise English.
 *
 * @param preferred - Stored user preference (may be null or unsupported)
 * @param languages - Browser languages in preference order (e.g. `navigator.languages`)
 * @returns The resolved locale
 */
export function resolveLocale(preferred: string | null | undefined, languages: readonly string[] = []): Locale {
  if (isLocale(preferred)) return preferred;
  for (const lang of languages) {
    const primary = lang.toLowerCase().split("-")[0];
    if (isLocale(primary)) return primary;
  }
  return FALLBACK_LOCALE;
}

/**
 * Flattens a nested catalog into a dot-key map. Non-string leaves are ignored.
 *
 * @param messages - Nested catalog
 * @param prefix - Key prefix (used for recursion)
 * @param out - Target map (used for recursion)
 * @returns The flat map
 */
export function flattenMessages(
  messages: Messages,
  prefix = "",
  out: Map<string, string> = new Map(),
): Map<string, string> {
  for (const [key, value] of Object.entries(messages)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(full, value);
    else if (value && typeof value === "object") flattenMessages(value, full, out);
  }
  return out;
}

/**
 * Replaces `{name}` placeholders with parameter values. Unknown placeholders
 * are left as is.
 *
 * @param template - Message text
 * @param params - Values
 * @returns The interpolated text
 */
export function interpolate(template: string, params?: Readonly<Record<string, unknown>>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined || value === null ? match : String(value);
  });
}

/** Cached plural rules per locale. */
const pluralRules = new Map<string, Intl.PluralRules>();

/**
 * Returns the CLDR plural category for a count.
 *
 * @param locale - Locale
 * @param count - Number
 * @returns Plural category (`one`, `other`, ...)
 */
function pluralCategory(locale: string, count: number): Intl.LDMLPluralRule {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  return rules.select(count);
}

/** A locale with its ordered catalogs (earlier catalogs win). */
interface LocaleCatalogs {
  locale: string;
  maps: Map<string, string>[];
}

/**
 * Looks up a key, trying the plural form first when a count is given.
 *
 * @param source - Locale and catalogs to search
 * @param key - Message key
 * @param count - Optional plural count
 * @returns The message, or undefined when missing
 */
function lookup(source: LocaleCatalogs, key: string, count: number | undefined): string | undefined {
  const plural = typeof count === "number" ? `${key}_${pluralCategory(source.locale, count)}` : undefined;
  for (const map of source.maps) {
    if (plural !== undefined) {
      const hit = map.get(plural) ?? map.get(`${key}_other`);
      if (hit !== undefined) return hit;
    }
    const hit = map.get(key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * Creates a translate function.
 *
 * Lookup order: the locale's catalogs (in the given order), then the fallback
 * (English) catalogs, then `params.default`, then the key itself.
 *
 * @param locale - Active locale
 * @param catalogs - Catalogs for the active locale, highest priority first
 * @param fallback - English catalogs, highest priority first (ignored when `locale` is English and equal)
 * @returns The translate function
 */
export function createTranslator(locale: string, catalogs: Messages[], fallback: Messages[] = []): Translate {
  const primary: LocaleCatalogs = { locale, maps: catalogs.map((c) => flattenMessages(c)) };
  const secondary: LocaleCatalogs = { locale: FALLBACK_LOCALE, maps: fallback.map((c) => flattenMessages(c)) };
  const numberFormat = new Intl.NumberFormat(locale);
  return (key, params) => {
    const count = typeof params?.count === "number" ? params.count : undefined;
    const message = lookup(primary, key, count) ?? lookup(secondary, key, count) ?? params?.default ?? key;
    return interpolate(message, count === undefined ? params : { ...params, count: numberFormat.format(count) });
  };
}

/** Locale-aware formatters (see {@link createFormatters}). */
export interface Formatters {
  /**
   * Formats a date/time.
   *
   * @param value - Date, epoch ms, or ISO string
   * @param options - `Intl.DateTimeFormat` options (default: medium date + medium time)
   * @returns The formatted string
   */
  date(value: Date | number | string, options?: Intl.DateTimeFormatOptions): string;
  /**
   * Formats a number.
   *
   * @param value - Number
   * @param options - `Intl.NumberFormat` options
   * @returns The formatted string
   */
  number(value: number, options?: Intl.NumberFormatOptions): string;
  /**
   * Formats a point in time relative to now ("3 minutes ago", "vor 3 Minuten").
   *
   * @param value - Date, epoch ms, or ISO string
   * @param now - Reference time in epoch ms (default `Date.now()`)
   * @returns The formatted string
   */
  relative(value: Date | number | string, now?: number): string;
}

/** Relative-time thresholds: unit and its length in seconds, largest first. */
const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

/**
 * Creates locale-aware formatters backed by `Intl`.
 *
 * @param locale - Active locale
 * @returns The formatters
 */
export function createFormatters(locale: string): Formatters {
  const defaultDate = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" });
  const relativeFormat = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const toDate = (value: Date | number | string) => (value instanceof Date ? value : new Date(value));
  return {
    date(value, options) {
      const date = toDate(value);
      return options ? date.toLocaleString(locale, options) : defaultDate.format(date);
    },
    number(value, options) {
      return value.toLocaleString(locale, options);
    },
    relative(value, now = Date.now()) {
      const seconds = Math.round((toDate(value).getTime() - now) / 1000);
      for (const [unit, length] of RELATIVE_UNITS) {
        if (Math.abs(seconds) >= length || unit === "second") {
          return relativeFormat.format(Math.round(seconds / length), unit);
        }
      }
      return relativeFormat.format(0, "second");
    },
  };
}

/**
 * A locale-bound i18n snapshot: the active locale with its translate function
 * and formatters. Extension pages receive it as a Svelte store (`palim.i18n`),
 * so `$i18n.t(...)` and `$i18n.format.date(...)` re-render on a locale switch.
 */
export interface I18n {
  /** Active locale. */
  readonly locale: Locale;
  /** Translates a key (see {@link Translate}). */
  readonly t: Translate;
  /** Locale-aware formatters. */
  readonly format: Formatters;
}

/**
 * Lists keys present in `reference` but missing in `candidate`, and keys
 * present in `candidate` but not in `reference`. Plural variants are compared
 * by base key, since languages use different plural categories.
 *
 * @param reference - Source catalog (English)
 * @param candidate - Translated catalog
 * @returns Missing and extra keys
 */
export function diffCatalogKeys(reference: Messages, candidate: Messages): { missing: string[]; extra: string[] } {
  const base = (key: string) => key.replace(/_(zero|one|two|few|many|other)$/, "");
  const ref = new Set([...flattenMessages(reference).keys()].map(base));
  const cand = new Set([...flattenMessages(candidate).keys()].map(base));
  return {
    missing: [...ref].filter((k) => !cand.has(k)).sort(),
    extra: [...cand].filter((k) => !ref.has(k)).sort(),
  };
}
