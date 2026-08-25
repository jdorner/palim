<!--
@component
Chat markdown renderer built on Comark, rendering to native Svelte components
(no `{@html}`) with Rangi syntax highlighting and Mermaid diagrams. Shared by
every chat render site so plugin/component wiring lives in one place.
-->
<script lang="ts">
import { Markdown } from "@comark/svelte";
import rangi from "@comark/svelte/plugins/rangi";
import type { ComarkPlugin, ComponentManifest } from "comark";
// Import the mermaid PARSER plugin from the core package (light, no renderer).
// Importing from `@comark/svelte/plugins/mermaid` would statically pull in the
// heavy `beautiful-mermaid` renderer and defeat the lazy load below, since that
// module re-exports both the plugin and the component.
import mermaid from "comark/plugins/mermaid";
import { githubDark, githubLight } from "rangi/themes";
import CodeBlock from "./CodeBlock.svelte";

interface Props {
  /** Raw markdown text to render. */
  content: string;
  /** Whether the content is still streaming in (enables auto-close + caret). */
  streaming?: boolean;
}

let { content, streaming = false }: Props = $props();

// `preStyles` gives the <pre> a base fg/bg so plain (uncolored) tokens stay
// readable in both themes; the { light, dark } pair drives the dark-mode CSS below.
const rangiPlugin = rangi({
  theme: { light: githubLight, dark: githubDark },
  preStyles: true,
});

const plugins: ComarkPlugin[] = [rangiPlugin, mermaid()];

// Wrap Rangi's `<pre>` in CodeBlock (language label, copy button, scroll body)
// via Comark's `Prose{Tag}` override convention.
const components = { ProsePre: CodeBlock };

// Lazy-load the Mermaid renderer so `beautiful-mermaid` is code-split out of the
// chat page's initial chunk and only loaded when a diagram appears.
const componentsManifest: ComponentManifest = (name: string) => {
  if (name === "mermaid") {
    return import("@comark/svelte/components/Mermaid.svelte");
  }
  return undefined;
};
</script>

<div class="markdown chat-markdown">
  <Markdown value={content} {plugins} {components} {componentsManifest} {streaming} />
</div>

<style>
/* Never let wide content (code blocks) stretch the wrapper past its container;
   the code block scrolls internally instead. */
.chat-markdown {
  min-width: 0;
  max-width: 100%;
}

/*
 * Dark-mode code highlighting. The `shiki` class and `--shiki-*` variables come
 * from Rangi (it emits them for Shiki compatibility) — do NOT rename them even
 * though Shiki is not a dependency. Rangi puts light colors inline and dark
 * colors in `--shiki-dark*`; here we switch to the dark values under `html.dark`.
 * `!important` is needed to beat the inline light styles.
 */

:global(html.dark) .chat-markdown :global(pre.shiki) {
  /* biome-ignore lint/complexity/noImportantStyles: must beat Rangi's inline light-theme styles */
  background-color: var(--shiki-dark-bg) !important;
  /* biome-ignore lint/complexity/noImportantStyles: must beat Rangi's inline light-theme styles */
  color: var(--shiki-dark) !important;
}

:global(html.dark) .chat-markdown :global(pre.shiki span) {
  /* biome-ignore lint/complexity/noImportantStyles: must beat Rangi's inline light-theme token styles */
  color: var(--shiki-dark) !important;
}
</style>
