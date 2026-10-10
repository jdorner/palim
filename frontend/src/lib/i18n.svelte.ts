/**
 * Host i18n store: the active locale, the core UI catalogs, and the catalogs of
 * loaded extensions.
 *
 * Core components translate with {@link t} (`{t("chat.send")}`). It reads rune
 * state, so templates re-render when the locale or the catalogs change. Keys are
 * typed against `locales/en.json`. Extension metadata (nav labels, page titles,
 * schema titles, step labels) is translated with {@link tx}, which looks up the
 * extension's own catalog and falls back to the English text from the manifest
 * or schema.
 *
 * Extension pages and `@palim/ui` kit components do not import this module; they
 * receive an {@link I18n} store (see `extensionHost.ts` and `kitI18n.ts`).
 *
 * @module
 */

import { type Readable, toStore } from "svelte/store";
import {
  createFormatters,
  createTranslator,
  FALLBACK_LOCALE,
  type Formatters,
  type I18n,
  type Locale,
  type Messages,
  resolveLocale,
  type Translate,
  type TranslateParams,
} from "$shared/i18n";
import { authFetch } from "./auth";
import { responseError } from "./http";
import { type CoreKey, coreEnglish as en, installTranslators } from "./i18nCore";
import { identity } from "./identity.svelte";

export type { CoreKey, CoreTranslate } from "./i18nCore";

/** Lazily loaded core catalogs for non-English locales. */
const CORE_LOADERS: Record<Exclude<Locale, "en">, () => Promise<{ default: Messages }>> = {
  de: () => import("../locales/de.json"),
};

/** Extension catalogs as served by `GET /api/i18n/:locale`. */
type ExtensionCatalogs = Record<string, Partial<Record<Locale, Messages>>>;

/** Reactive i18n state backed by Svelte 5 runes. */
class I18nStore {
  /** Active locale. */
  locale = $state<Locale>(resolveLocale(null, typeof navigator === "undefined" ? [] : navigator.languages));
  /** Core catalog of the active locale (English is bundled and always present). */
  #core = $state.raw<Messages>(en);
  /** Extension catalogs (active locale + English fallback). */
  #extensions = $state.raw<ExtensionCatalogs>({});
  /** Increments on every successful load; guards against out-of-order responses. */
  #loadSeq = 0;

  /** Translator for core keys. */
  #coreT = $derived(createTranslator(this.locale, [this.#core], [en]));
  /** Formatters for the active locale. */
  #format = $derived(createFormatters(this.locale));
  /** Per-extension translators (cleared whenever locale or catalogs change). */
  #extCache = $derived.by(() => {
    void this.locale;
    void this.#extensions;
    void this.#core;
    return { metadata: new Map<string, Translate>(), page: new Map<string, Translate>() };
  });

  /** Locale-aware formatters for the active locale. */
  get format(): Formatters {
    return this.#format;
  }

  /**
   * Translates a core UI key.
   *
   * @param key - Message key from `locales/en.json`
   * @param params - Interpolation values (`count` selects the plural form)
   * @returns The translated string
   */
  t(key: CoreKey, params?: TranslateParams): string {
    return this.#coreT(key, params);
  }

  /**
   * Translates extension metadata, looking only at the extension's catalog.
   *
   * @param extension - Extension name
   * @param key - Catalog key (e.g. `nav./datatables`, `settings.apiUrl.title`)
   * @param fallback - English text from the manifest or schema
   * @param params - Interpolation values
   * @returns The translation, or the fallback when the extension has none
   */
  tx(extension: string, key: string, fallback: string, params?: TranslateParams): string {
    return this.#extensionTranslator(extension, "metadata")(key, { ...params, default: fallback });
  }

  /**
   * Returns the translator for an extension page: the extension's catalog first,
   * then the core catalog (so pages can reuse `common.*` keys).
   *
   * @param extension - Extension name
   * @returns The translate function for the current locale
   */
  pageTranslator(extension: string): Translate {
    return this.#extensionTranslator(extension, "page");
  }

  /**
   * Builds (or returns the cached) translator for an extension.
   *
   * @param extension - Extension name
   * @param kind - `metadata` (extension catalog only) or `page` (with core fallback)
   * @returns The translate function
   */
  #extensionTranslator(extension: string, kind: "metadata" | "page"): Translate {
    const cache = this.#extCache[kind];
    let translator = cache.get(extension);
    if (!translator) {
      const catalogs = this.#extensions[extension] ?? {};
      const own = catalogs[this.locale];
      const ownEn = catalogs[FALLBACK_LOCALE];
      translator =
        kind === "metadata"
          ? createTranslator(this.locale, own ? [own] : [], ownEn ? [ownEn] : [])
          : createTranslator(this.locale, own ? [own, this.#core] : [this.#core], ownEn ? [ownEn, en] : [en]);
      cache.set(extension, translator);
    }
    return translator;
  }

  /**
   * Returns a store of the {@link I18n} snapshot for an extension page, or for
   * the host when no extension is given.
   *
   * @param extension - Extension name, or undefined for core
   * @returns A Svelte store that updates on locale or catalog changes
   */
  store(extension?: string): Readable<I18n> {
    return toStore(() => ({
      locale: this.locale,
      t: extension
        ? this.pageTranslator(extension)
        : (key: string, params?: TranslateParams) => this.#coreT(key, params),
      format: this.#format,
    }));
  }

  /**
   * Switches the locale and loads its core and extension catalogs.
   *
   * @param locale - Locale to activate
   * @param options - `extensions: false` skips the extension catalogs (e.g. on the login page)
   */
  async setLocale(locale: Locale, options: { extensions?: boolean } = {}): Promise<void> {
    const seq = ++this.#loadSeq;
    const [core, extensions] = await Promise.all([
      locale === "en" ? Promise.resolve(en) : CORE_LOADERS[locale]().then((m) => m.default),
      options.extensions === false ? Promise.resolve(undefined) : this.#fetchExtensionCatalogs(locale),
    ]);
    if (seq !== this.#loadSeq) return; // a newer switch won
    this.#core = core;
    if (extensions) this.#extensions = extensions;
    this.locale = locale;
    if (typeof document !== "undefined") document.documentElement.lang = locale;
  }

  /**
   * Persists the signed-in user's language preference and updates the identity,
   * which makes the app shell switch to the resolved locale.
   *
   * @param preference - Locale, or null to follow the browser language
   * @throws {Error} When the server rejects the change
   */
  async savePreference(preference: Locale | null): Promise<void> {
    const res = await authFetch("/api/auth/me/locale", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ locale: preference }),
    });
    if (!res.ok) throw new Error(await responseError(res));
    if (identity.user) identity.user = { ...identity.user, locale: preference ?? undefined };
  }

  /** Refetches the extension catalogs for the active locale (after extensions changed). */
  async reloadExtensions(): Promise<void> {
    const locale = this.locale;
    const extensions = await this.#fetchExtensionCatalogs(locale);
    if (extensions && locale === this.locale) this.#extensions = extensions;
  }

  /**
   * Fetches extension catalogs. Failures are logged and leave the catalogs unchanged.
   *
   * @param locale - Locale to fetch
   * @returns The catalogs, or undefined on failure
   */
  async #fetchExtensionCatalogs(locale: Locale): Promise<ExtensionCatalogs | undefined> {
    try {
      const res = await authFetch(`/api/i18n/${locale}`);
      if (!res.ok) return undefined;
      const data = (await res.json()) as { extensions: ExtensionCatalogs };
      return data.extensions;
    } catch (err) {
      console.warn("Failed to load extension translations:", err);
      return undefined;
    }
  }
}

/** Singleton i18n store shared across the app. */
export const i18n = new I18nStore();

// Plain TypeScript helpers translate through i18nCore's delegates.
installTranslators(
  (key, params) => i18n.t(key, params),
  (extension, key, fallback, params) => i18n.tx(extension, key, fallback, params),
  () => i18n.format,
);

/**
 * Translates a core UI key (shorthand for `i18n.t`).
 *
 * @param key - Message key from `locales/en.json`
 * @param params - Interpolation values (`count` selects the plural form)
 * @returns The translated string
 */
export function t(key: CoreKey, params?: TranslateParams): string {
  return i18n.t(key, params);
}

/**
 * Translates extension metadata (shorthand for `i18n.tx`).
 *
 * @param extension - Extension name
 * @param key - Catalog key
 * @param fallback - English text from the manifest or schema
 * @param params - Interpolation values
 * @returns The translation, or the fallback
 */
export function tx(extension: string, key: string, fallback: string, params?: TranslateParams): string {
  return i18n.tx(extension, key, fallback, params);
}
