/**
 * i18n access for `@palim/ui` kit components.
 *
 * Kit components are compiled both into the host app and into every extension
 * bundle, so they must not import the host i18n store (`i18n.svelte.ts`): an
 * extension bundle would get its own, never-initialized copy. Instead they read
 * an {@link I18n} store from Svelte context. The host app provides it in
 * `App.svelte`; the extension UI builder's mount wrapper provides the page's
 * `palim.i18n`. The context key is registered with `Symbol.for` so all module
 * copies agree on it.
 *
 * @module
 */

import { getContext, setContext } from "svelte";
import { type Readable, readable } from "svelte/store";
import { createFormatters, FALLBACK_LOCALE, type I18n, interpolate } from "$shared/i18n";

/** Context key under which the active {@link I18n} store is provided. */
export const I18N_CONTEXT_KEY = Symbol.for("palim.i18n");

/** Used when no provider is mounted (e.g. isolated component tests): returns defaults or keys. */
const FALLBACK_I18N: Readable<I18n> = readable({
  locale: FALLBACK_LOCALE,
  t: (key, params) => interpolate(params?.default ?? key, params),
  format: createFormatters(FALLBACK_LOCALE),
});

/**
 * Returns the active i18n store. Must be called during component initialization.
 *
 * @returns A store of the current {@link I18n} snapshot (`$i18n.t("common.cancel")`)
 */
export function useI18n(): Readable<I18n> {
  return getContext<Readable<I18n> | undefined>(I18N_CONTEXT_KEY) ?? FALLBACK_I18N;
}

/**
 * Provides the i18n store to descendant components. Must be called during
 * component initialization.
 *
 * @param store - Store of the current {@link I18n} snapshot
 */
export function provideI18n(store: Readable<I18n>): void {
  setContext(I18N_CONTEXT_KEY, store);
}
