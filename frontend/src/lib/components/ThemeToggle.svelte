<script lang="ts">
import MoonIcon from "phosphor-svelte/lib/MoonIcon";
import SunIcon from "phosphor-svelte/lib/SunIcon";
import { onMount } from "svelte";
import { Button } from "$lib/components/ui/button";

let dark = $state(false);

function toggleTheme() {
  dark = !dark;
  if (dark) {
    document.documentElement.classList.add("dark");
    localStorage.setItem("theme", "dark");
  } else {
    document.documentElement.classList.remove("dark");
    localStorage.setItem("theme", "light");
  }
}

onMount(() => {
  dark = document.documentElement.classList.contains("dark");
});
</script>

<Button variant="outline" size="icon" onclick={toggleTheme} aria-label="Toggle theme">
  {#if dark}
    <SunIcon size={20} aria-hidden="true" />
  {:else}
    <MoonIcon size={20} aria-hidden="true" />
  {/if}
</Button>
