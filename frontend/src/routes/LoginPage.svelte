<script lang="ts">
import { setToken } from "$lib/auth";
import { Button } from "$lib/components/ui/button";
import { t } from "$lib/i18n.svelte";
import { identity } from "$lib/identity.svelte";
import { navigate } from "../router";

let username = $state("");
let password = $state("");
let error = $state("");
let submitting = $state(false);

async function handleSubmit() {
  error = "";
  submitting = true;
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (res.ok) {
      const data = await res.json();
      setToken(data.token);
      identity.set(data.user, data.ability);
      navigate("/");
    } else if (res.status === 401) {
      error = t("login.invalid");
    } else if (res.status === 429) {
      const seconds = Number(res.headers.get("retry-after")) || 0;
      error = !seconds
        ? t("login.tooMany")
        : seconds < 60
          ? t("login.tooManySeconds", { seconds })
          : t("login.tooManyMinutes", { minutes: Math.ceil(seconds / 60) });
    } else {
      error = t("login.failed");
    }
  } catch {
    error = t("login.unreachable");
  } finally {
    submitting = false;
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !submitting) handleSubmit();
}
</script>

<div class="flex items-center justify-center min-h-screen bg-background">
  <div class="w-full max-w-sm p-6 space-y-6">
    <div class="text-center space-y-2">
      <h1 class="text-2xl font-bold">{t("login.title")}</h1>
      <p class="text-sm text-muted-foreground">{t("login.subtitle")}</p>
    </div>

    <div class="space-y-4">
      <div class="space-y-2">
        <label for="username" class="text-sm font-medium">{t("login.username")}</label>
        <input
          id="username"
          type="text"
          autocomplete="username"
          bind:value={username}
          onkeydown={handleKeydown}
          placeholder={t("login.usernamePlaceholder")}
          class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background
            placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2
            focus-visible:ring-ring focus-visible:ring-offset-2"
          disabled={submitting}
        >
      </div>

      <div class="space-y-2">
        <label for="password" class="text-sm font-medium">{t("login.password")}</label>
        <input
          id="password"
          type="password"
          autocomplete="current-password"
          bind:value={password}
          onkeydown={handleKeydown}
          placeholder={t("login.passwordPlaceholder")}
          class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background
            placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2
            focus-visible:ring-ring focus-visible:ring-offset-2"
          disabled={submitting}
        >
      </div>

      {#if error}
        <p class="text-sm text-destructive">{error}</p>
      {/if}

      <Button size="default" class="w-full" disabled={submitting || !username || !password} onclick={handleSubmit}>
        {submitting ? t("login.signingIn") : t("login.title")}
      </Button>
    </div>
  </div>
</div>
