<!-- Account settings: language, appearance, sign-out. -->
<script lang="ts">
import { Button } from "@palim/ui";
import SignOutIcon from "phosphor-svelte/lib/SignOutIcon";
import { session } from "$app/auth.svelte";
import { t } from "$app/i18n.svelte";
import { isLocale, LOCALE_NAMES, SUPPORTED_LOCALES } from "$shared/i18n";

type Theme = "system" | "light" | "dark";

let error = $state<string | null>(null);
let theme = $state<Theme>(readTheme());
let locale = $state<string>(isLocale(session.user?.locale) ? (session.user?.locale ?? "") : "");

function readTheme(): Theme {
  try {
    const stored = localStorage.getItem("theme");
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function applyTheme(next: Theme) {
  theme = next;
  try {
    if (next === "system") localStorage.removeItem("theme");
    else localStorage.setItem("theme", next);
  } catch {
    // Not persisted; still applied below.
  }
  const dark = next === "dark" || (next === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

async function changeLocale(next: string) {
  error = null;
  const previous = locale;
  locale = next;
  try {
    await session.setLocale(next || null);
  } catch (err) {
    locale = previous;
    error = t("settings.saveFailed", { message: err instanceof Error ? err.message : String(err) });
  }
}

const selectClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-ring";
</script>

<div class="space-y-6">
  <h2 class="text-xl font-semibold">{t("settings.title")}</h2>
  <p class="text-sm text-muted-foreground">{t("settings.account", { username: session.user?.username ?? "" })}</p>

  <div class="space-y-1">
    <label class="text-sm font-medium" for="settings-locale">{t("settings.language")}</label>
    <select
      id="settings-locale"
      class={selectClass}
      value={locale}
      onchange={(e) => changeLocale(e.currentTarget.value)}
    >
      <option value="">{t("settings.browserDefault")}</option>
      {#each SUPPORTED_LOCALES as option (option)}
        <option value={option}>{LOCALE_NAMES[option]}</option>
      {/each}
    </select>
  </div>

  <div class="space-y-1">
    <label class="text-sm font-medium" for="settings-theme">{t("settings.theme")}</label>
    <select
      id="settings-theme"
      class={selectClass}
      value={theme}
      onchange={(e) => applyTheme(e.currentTarget.value as Theme)}
    >
      <option value="system">{t("settings.themeSystem")}</option>
      <option value="light">{t("settings.themeLight")}</option>
      <option value="dark">{t("settings.themeDark")}</option>
    </select>
  </div>

  {#if error}
    <p class="text-sm text-destructive" role="alert">{error}</p>
  {/if}

  <Button variant="outline" onclick={() => session.logout()}>
    <SignOutIcon size={16} class="mr-1.5" aria-hidden="true" />
    {t("settings.logout")}
  </Button>
</div>
