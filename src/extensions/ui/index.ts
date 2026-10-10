/**
 * Extension UI SDK, importable from extension page code as `@ext/ui`.
 *
 * Pages receive the host API as their `palim` prop:
 *
 * ```svelte
 * <script lang="ts">
 *   import type { PalimHost } from "@ext/ui";
 *   import { Button, Card } from "@palim/ui";
 *
 *   let { palim }: { palim: PalimHost } = $props();
 *   const theme = palim.theme; // a Svelte store: `$theme` is true in dark mode
 *   const i18n = palim.i18n; // a Svelte store: `$i18n.t("accounts.title")`
 *   const accounts = palim.json<{ accounts: string[] }>("/accounts");
 * </script>
 * ```
 *
 * This module is bundled into browser code: it must not import server modules.
 * It uses relative imports because external extensions' tsconfigs do not map
 * the core `@shared/*` alias.
 *
 * @module
 */

import { getContext } from "svelte";
import type { PalimHost } from "../../../shared/extensionUi";

export type {
  ExtensionUiEvent,
  MountExtensionPage,
  PalimConfirmOptions,
  PalimHost,
  PalimJsonInit,
  PalimNotifyKind,
  PalimPageRoute,
} from "../../../shared/extensionUi";
export type { Formatters, I18n, Locale, Messages, Translate, TranslateParams } from "../../../shared/i18n";

/**
 * Returns the page's i18n store (the same object as `palim.i18n`) from Svelte
 * context, for nested components that do not receive the `palim` prop. Must be
 * called during component initialization.
 *
 * ```svelte
 * <script lang="ts">
 *   import { useI18n } from "@ext/ui";
 *   const i18n = useI18n();
 * </script>
 * <span>{$i18n.t("columns.type")}</span>
 * ```
 *
 * @returns The i18n store
 * @throws {Error} When called outside an extension page
 */
export function useI18n(): PalimHost["i18n"] {
  const store = getContext<PalimHost["i18n"] | undefined>(Symbol.for("palim.i18n"));
  if (!store) throw new Error("useI18n() must be called inside an extension page component");
  return store;
}
