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

export type {
  ExtensionUiEvent,
  MountExtensionPage,
  PalimConfirmOptions,
  PalimHost,
  PalimJsonInit,
  PalimNotifyKind,
  PalimPageRoute,
} from "../../../shared/extensionUi";
