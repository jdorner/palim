<script lang="ts">
import CardsIcon from "phosphor-svelte/lib/CardsIcon";
import SidebarSimpleIcon from "phosphor-svelte/lib/SidebarSimpleIcon";
import { detailPanelMode } from "$lib/detailPanelMode.svelte";

interface Props {
  class?: string;
}

let { class: className = "" }: Props = $props();
</script>

<button
  type="button"
  class="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground rounded hover:bg-accent hover:text-foreground transition-colors {className}"
  onclick={() => detailPanelMode.toggle()}
  title="Show step details {detailPanelMode.current === "sidebar" ? "beneath the selected node" : "in a sidebar"}"
>
  {#if detailPanelMode.current === "sidebar"}
    <SidebarSimpleIcon size={14} aria-hidden="true" />
    Sidebar
  {:else}
    <CardsIcon size={14} aria-hidden="true" />
    Floating
  {/if}
</button>
