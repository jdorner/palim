<!-- Shown when the account has no portal module available. -->
<script lang="ts">
import { Button } from "@palim/ui";
import { session } from "$app/auth.svelte";
import { t } from "$app/i18n.svelte";
</script>

<div class="flex min-h-dvh items-center justify-center p-4">
  <div class="w-full max-w-sm space-y-4 rounded-lg border bg-card p-6 text-center">
    <h1 class="text-lg font-semibold">{t("noAccess.title")}</h1>
    <p class="text-sm text-muted-foreground">{t("noAccess.description", { username: session.user?.username ?? "" })}</p>
    <Button variant="outline" onclick={() => session.logout()}>{t("settings.logout")}</Button>
  </div>
</div>
