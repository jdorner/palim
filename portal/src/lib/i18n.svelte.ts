/**
 * Portal i18n: its own catalogs (`src/locales`), the shared pure i18n runtime,
 * and the active locale (the account's preference, else the browser's).
 *
 * The store is also provided through Svelte context (`provideI18n`) so the
 * reused `@palim/ui` kit components translate their built-in labels.
 *
 * @module
 */

import { type Readable, readable } from "svelte/store";
import {
  createFormatters,
  createTranslator,
  type I18n,
  type Locale,
  resolveLocale,
  type TranslateParams,
} from "$shared/i18n";
import de from "../locales/de.json";
import en from "../locales/en.json";

/** Portal message catalogs by locale. */
const CATALOGS: Record<Locale, typeof en> = { en, de };

/** Builds an {@link I18n} snapshot for a locale. */
function snapshot(locale: Locale): I18n {
  return { locale, t: createTranslator(locale, [CATALOGS[locale]], [CATALOGS.en]), format: createFormatters(locale) };
}

/** Reactive i18n state. */
class PortalI18n {
  /** The current snapshot. */
  current = $state<I18n>(snapshot(resolveLocale(null, navigator.languages)));
  #listeners = new Set<(value: I18n) => void>();

  /** A store of the snapshot, for the kit's Svelte context. */
  readonly store: Readable<I18n> = readable(this.current, (set) => {
    this.#listeners.add(set);
    set(this.current);
    return () => this.#listeners.delete(set);
  });

  /**
   * Switches the locale: the account preference wins, else the browser language.
   *
   * @param preferred - The account's locale (null/undefined = browser)
   */
  setPreferred(preferred: string | null | undefined): void {
    const locale = resolveLocale(preferred, navigator.languages);
    if (locale === this.current.locale) return;
    this.current = snapshot(locale);
    document.documentElement.lang = locale;
    for (const set of this.#listeners) set(this.current);
  }
}

/** The portal i18n store. */
export const i18n = new PortalI18n();

/**
 * Translates a portal key in the active locale.
 *
 * @param key - Dot key (e.g. "tasks.title")
 * @param params - Interpolation params
 * @returns The translated text
 */
export function t(key: string, params?: TranslateParams): string {
  return i18n.current.t(key, params);
}
