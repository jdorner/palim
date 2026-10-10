<script lang="ts">
import CaretDownIcon from "phosphor-svelte/lib/CaretDownIcon";
import CheckIcon from "phosphor-svelte/lib/CheckIcon";
import SignOutIcon from "phosphor-svelte/lib/SignOutIcon";
import UserIcon from "phosphor-svelte/lib/UserIcon";
import { forceLogout } from "$lib/auth";
import { Button } from "$lib/components/ui/button";
import { i18n, t } from "$lib/i18n.svelte";
import { identity } from "$lib/identity.svelte";
import { LOCALE_NAMES, type Locale, SUPPORTED_LOCALES } from "$shared/i18n";

/** Whether the dropdown menu is open. */
let open = $state(false);
/** The menu container, used to detect outside clicks. */
let container = $state<HTMLElement | null>(null);

/** Display label for the current user (display name, else username). */
let label = $derived(identity.user?.displayName || identity.user?.username || t("userMenu.account"));

/** The stored language preference (null follows the browser language). */
let preference = $derived<Locale | null>((identity.user?.locale as Locale | undefined) ?? null);
/** Error from the last failed language change. */
let languageError = $state<string | null>(null);

/** Language choices: browser default, then every supported locale in its own language. */
let languageOptions = $derived<Array<{ value: Locale | null; label: string }>>([
  { value: null, label: t("language.browserDefault") },
  ...SUPPORTED_LOCALES.map((locale) => ({ value: locale, label: LOCALE_NAMES[locale] })),
]);

async function chooseLanguage(value: Locale | null) {
  languageError = null;
  try {
    await i18n.savePreference(value);
  } catch (err) {
    languageError = t("language.saveFailed", { error: err instanceof Error ? err.message : String(err) });
  }
}

function toggle() {
  open = !open;
}

function close() {
  open = false;
}

function handleLogout() {
  close();
  forceLogout();
}

/** Closes the menu when clicking outside of it. */
function onWindowPointerDown(event: PointerEvent) {
  if (!open) return;
  if (container && event.target instanceof Node && !container.contains(event.target)) {
    close();
  }
}

function onWindowKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") close();
}
</script>

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={onWindowKeydown} />

<div class="relative" bind:this={container}>
  <Button
    type="button"
    variant="outline"
    onclick={toggle}
    aria-haspopup="menu"
    aria-expanded={open}
    class="text-sm text-foreground transition-colors gap-1.5"
  >
    <UserIcon size={16} aria-hidden="true" />
    <span class="max-w-48 truncate">{label}</span>
    <CaretDownIcon size={12} aria-hidden="true" class="opacity-70 {open ? "rotate-180" : ""} transition-transform" />
  </Button>

  {#if open}
    <div
      role="menu"
      class="absolute right-0 mt-1 min-w-48 rounded-md border border-border bg-background text-foreground p-1 shadow-md z-50"
    >
      <div class="px-2 pt-1 pb-0.5 text-xs font-medium text-muted-foreground" id="user-menu-language">
        {t("userMenu.language")}
      </div>
      <fieldset class="m-0 border-0 p-0" aria-labelledby="user-menu-language">
        {#each languageOptions as option (option.value ?? "browser")}
          <button
            type="button"
            role="menuitemradio"
            aria-checked={preference === option.value}
            onclick={() => chooseLanguage(option.value)}
            class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-left
              text-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            <CheckIcon size={16} aria-hidden="true" class={preference === option.value ? "" : "invisible"} />
            {option.label}
          </button>
        {/each}
      </fieldset>
      {#if languageError}
        <p class="px-2 py-1 text-xs text-destructive" role="alert">{languageError}</p>
      {/if}
      <hr class="my-1 border-border">
      <button
        type="button"
        role="menuitem"
        onclick={handleLogout}
        class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-left
          text-foreground hover:bg-accent hover:text-foreground transition-colors"
      >
        <SignOutIcon size={16} aria-hidden="true" />
        {t("userMenu.logout")}
      </button>
    </div>
  {/if}
</div>
