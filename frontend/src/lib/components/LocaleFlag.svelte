<script lang="ts">
/**
 * Small inline SVG flag for a UI locale. SVG instead of flag emoji, which
 * Windows renders as plain letters ("GB", "DE").
 */
import type { Locale } from "$shared/i18n";

let { locale, class: className = "" }: { locale: Locale; class?: string } = $props();

// Unique clip-path ids per instance (several flags can be on the page at once).
const uid = $props.id();
</script>

{#if locale === "de"}
  <svg viewBox="0 0 5 3" class="h-3 w-5 shrink-0 rounded-[2px] {className}" aria-hidden="true">
    <rect width="5" height="1" fill="#000" />
    <rect y="1" width="5" height="1" fill="#DD0000" />
    <rect y="2" width="5" height="1" fill="#FFCE00" />
  </svg>
{:else if locale === "en"}
  <svg viewBox="0 0 60 36" class="h-3 w-5 shrink-0 rounded-[2px] {className}" aria-hidden="true">
    <clipPath id="{uid}-diag"><path d="M30,18 h30 v18 z v18 h-30 z h-30 v-18 z v-18 h30 z" /></clipPath>
    <rect width="60" height="36" fill="#012169" />
    <path d="M0,0 L60,36 M60,0 L0,36" stroke="#fff" stroke-width="7" />
    <path d="M0,0 L60,36 M60,0 L0,36" stroke="#C8102E" stroke-width="4" clip-path="url(#{uid}-diag)" />
    <path d="M30,0 v36 M0,18 h60" stroke="#fff" stroke-width="12" />
    <path d="M30,0 v36 M0,18 h60" stroke="#C8102E" stroke-width="7" />
  </svg>
{/if}
