<!--
@component
Chrome for a highlighted code block: header bar (language label + copy button)
and a scroll body that grows to a max height before scrolling. Used as a Comark
`ProsePre` override; re-applies Rangi's `class`/`style` to the inner `<pre>` so
theme colors and the `--shiki-dark*` dark-mode hooks are preserved.
-->
<script lang="ts">
import CheckIcon from "phosphor-svelte/lib/CheckIcon";
import CopyIcon from "phosphor-svelte/lib/CopyIcon";
import { onMount, type Snippet } from "svelte";

interface Props {
  /** Fence language (e.g. "javascript"); "plain"/empty when none was given. */
  language?: string;
  /** Class Rangi put on the <pre> (includes `shiki` + theme classes). */
  class?: string;
  /** Inline style Rangi put on the <pre> (theme bg/fg + `--shiki-dark*`). */
  style?: string;
  /** The rendered <code> element. */
  children?: Snippet;
  /** Raw AST node passed by Comark; accepted to avoid an unknown-prop warning. */
  __node?: unknown;
}

let { language, class: preClass = "", style, children }: Props = $props();

let preEl = $state<HTMLPreElement | undefined>(undefined);
let bodyEl = $state<HTMLDivElement | undefined>(undefined);
let copied = $state(false);
let copyTimer: ReturnType<typeof setTimeout> | undefined;

// Scroll-lock: follow the newest lines while streaming code grows, unless the
// user scrolls up. Direction-based (an upward delta = user reading back), same
// approach as the message area.
let followBottom = false;
let lastScrollTop = 0;
let sawInitialLayout = false;

function isAtBottom(): boolean {
  if (!bodyEl) return false;
  return bodyEl.scrollTop + bodyEl.clientHeight >= bodyEl.scrollHeight - 4;
}

function pinToBottom() {
  if (!bodyEl) return;
  bodyEl.scrollTop = bodyEl.scrollHeight;
  lastScrollTop = bodyEl.scrollTop;
}

function handleScroll() {
  if (!bodyEl) return;
  const current = bodyEl.scrollTop;
  if (current < lastScrollTop - 1) {
    followBottom = false;
  } else if (isAtBottom()) {
    followBottom = true;
  }
  lastScrollTop = current;
}

onMount(() => {
  if (!bodyEl) return;
  const observer = new ResizeObserver(() => {
    if (!bodyEl) return;
    // Skip the initial layout so a finalized tall block opens at the top rather
    // than jumping to its end; only follow growth that happens afterwards.
    if (!sawInitialLayout) {
      sawInitialLayout = true;
      followBottom = isAtBottom();
      lastScrollTop = bodyEl.scrollTop;
      return;
    }
    if (followBottom) pinToBottom();
  });
  if (preEl) observer.observe(preEl);
  observer.observe(bodyEl);
  return () => observer.disconnect();
});

let label = $derived(language && language !== "plain" ? language.toUpperCase() : "");

async function copy() {
  const text = preEl?.textContent ?? "";
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copied = false;
    }, 1500);
  } catch (err) {
    console.error("Copy failed:", err);
  }
}
</script>

<figure class="code-block">
  <figcaption class="code-block__bar">
    <span class="code-block__lang">{label}</span>
    <button
      type="button"
      class="code-block__copy"
      onclick={copy}
      aria-label={copied ? "Copied" : "Copy code"}
      title={copied ? "Copied" : "Copy code"}
    >
      {#if copied}
        <CheckIcon class="w-3.5 h-3.5" aria-hidden="true" />
      {:else}
        <CopyIcon class="w-3.5 h-3.5" aria-hidden="true" />
      {/if}
    </button>
  </figcaption>
  <div class="code-block__body" bind:this={bodyEl} onscroll={handleScroll}>
    <pre bind:this={preEl} class={preClass} {style}>{@render children?.()}</pre>
  </div>
</figure>

<style>
.code-block {
  margin: 0.5rem 0;
  border: 1px solid hsl(var(--muted-foreground) / 0.3);
  border-radius: 0.375rem;
  overflow: hidden;
  max-width: 100%;
}

.code-block__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.25rem 0.5rem 0.25rem 0.75rem;
  background: hsl(var(--muted-foreground) / 0.12);
  border-bottom: 1px solid hsl(var(--muted-foreground) / 0.2);
}

.code-block__lang {
  font-family: var(--font-mono, monospace);
  font-size: 0.7rem;
  letter-spacing: 0.03em;
  color: hsl(var(--muted-foreground));
}

.code-block__copy {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.25rem;
  border-radius: 0.25rem;
  color: hsl(var(--muted-foreground));
  transition:
    color 0.15s,
    background-color 0.15s;
}

.code-block__copy:hover {
  color: hsl(var(--foreground));
  background: hsl(var(--muted-foreground) / 0.2);
}

/* Grows to a cap, then scrolls (vertical past max-height, horizontal for long lines). */
.code-block__body {
  max-height: 32rem;
  overflow: auto;
  /* Allow the body to shrink below its content width so its own horizontal
     scrollbar handles long lines instead of widening the whole container. */
  min-width: 0;
}

.code-block__body :global(pre) {
  margin: 0;
  border: 0;
  border-radius: 0;
  padding: 0.75rem;
  white-space: pre; /* no wrap; long lines scroll horizontally */
}
</style>
