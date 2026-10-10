<script lang="ts">
import CardsIcon from "phosphor-svelte/lib/CardsIcon";
import SidebarSimpleIcon from "phosphor-svelte/lib/SidebarSimpleIcon";
import { detailPanelMode } from "$lib/detailPanelMode.svelte";
import { t } from "$lib/i18n.svelte";

interface Props {
  class?: string;
}

let { class: className = "" }: Props = $props();
</script>

<button
  type="button"
  class="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground rounded hover:bg-accent hover:text-foreground transition-colors {className}"
  onclick={() => detailPanelMode.toggle()}
  title={detailPanelMode.current === "sidebar" ? t("workflows.detailsBeneath") : t("workflows.detailsSidebar")}
>
  {#if detailPanelMode.current === "sidebar"}
    <SidebarSimpleIcon size={14} aria-hidden="true" />
    {t("workflows.modeSidebar")}
  {:else}
    <CardsIcon size={14} aria-hidden="true" />
    {t("workflows.modeFloating")}
  {/if}
</button>
