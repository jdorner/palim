<!-- Sign-in form. -->
<script lang="ts">
import { Button } from "@palim/ui";
import { ApiError } from "$app/api";
import { session } from "$app/auth.svelte";
import { t } from "$app/i18n.svelte";

let username = $state("");
let password = $state("");
let busy = $state(false);
let error = $state<string | null>(null);

async function submit(e: SubmitEvent) {
  e.preventDefault();
  error = null;
  busy = true;
  try {
    await session.login(username.trim(), password);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) error = t("login.invalid");
    else if (err instanceof ApiError && err.status === 429) error = t("login.locked");
    else error = t("login.failed", { message: err instanceof Error ? err.message : String(err) });
  } finally {
    busy = false;
    password = "";
  }
}

const inputClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-ring";
</script>

<div class="flex min-h-dvh items-center justify-center p-4">
  <form class="w-full max-w-sm space-y-4 rounded-lg border bg-card p-6 shadow-sm" onsubmit={submit}>
    <div class="space-y-1 text-center">
      <img src="./favicon.svg" alt="" class="mx-auto size-10">
      <h1 class="text-xl font-semibold">{t("app.title")}</h1>
      <p class="text-sm text-muted-foreground">{t("login.subtitle")}</p>
    </div>
    <div class="space-y-1">
      <label class="text-sm font-medium" for="login-username">{t("login.username")}</label>
      <input
        id="login-username"
        class={inputClass}
        autocomplete="username"
        autocapitalize="none"
        required
        bind:value={username}
      >
    </div>
    <div class="space-y-1">
      <label class="text-sm font-medium" for="login-password">{t("login.password")}</label>
      <input
        id="login-password"
        type="password"
        class={inputClass}
        autocomplete="current-password"
        required
        bind:value={password}
      >
    </div>
    {#if error}
      <p class="text-sm text-destructive" role="alert">{error}</p>
    {/if}
    <Button type="submit" class="w-full" disabled={busy}>{busy ? t("login.submitting") : t("login.submit")}</Button>
  </form>
</div>
