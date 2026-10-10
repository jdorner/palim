<!--
  Shown instead of the operator UI when a portal account signs in here.
  Portal accounts can only use the portal; the server refuses everything else.
-->
<script lang="ts">
import ArrowSquareOutIcon from "phosphor-svelte/lib/ArrowSquareOutIcon";
import SignOutIcon from "phosphor-svelte/lib/SignOutIcon";
import UserCircleIcon from "phosphor-svelte/lib/UserCircleIcon";
import { forceLogout } from "$lib/auth";
import { Button } from "$lib/components/ui/button";
import { buttonVariants } from "$lib/components/ui/button/button.svelte";
import { t } from "$lib/i18n.svelte";
import { identity } from "$lib/identity.svelte";
</script>

<div class="min-h-screen flex items-center justify-center p-6">
  <div class="max-w-md w-full rounded-lg border border-border bg-card p-6 space-y-4 text-center">
    <UserCircleIcon size={40} class="mx-auto text-muted-foreground" aria-hidden="true" />
    <h1 class="text-lg font-semibold">{t("portalAccount.title")}</h1>
    <p class="text-sm text-muted-foreground">
      {identity.portalUrl
        ? t("portalAccount.descriptionWithLink", { username: identity.user?.username ?? "" })
        : t("portalAccount.description", { username: identity.user?.username ?? "" })}
    </p>
    <div class="flex justify-center gap-2">
      {#if identity.portalUrl}
        <a href={identity.portalUrl} class={buttonVariants()}>
          <ArrowSquareOutIcon size={16} class="mr-1.5" aria-hidden="true" />
          {t("portalAccount.openPortal")}
        </a>
      {/if}
      <Button variant="outline" onclick={forceLogout}>
        <SignOutIcon size={16} class="mr-1.5" aria-hidden="true" />
        {t("userMenu.logout")}
      </Button>
    </div>
  </div>
</div>
