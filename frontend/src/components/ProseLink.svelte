<!--
@component
Anchor override for Comark-rendered markdown. Opens links in a new browser tab
(instead of replacing Palim's own tab) and applies `rel="noopener noreferrer"`
to prevent the opened page from accessing `window.opener`.

Registered as `ProseA` in ChatMarkdown so every markdown link across chat and
job logs shares this behavior. Comark passes through the parsed anchor
attributes (`href`, `title`, ...) as props via `...rest`.
-->
<script lang="ts">
import type { Snippet } from "svelte";

interface Props {
  /** Link target URL parsed from the markdown. */
  href?: string;
  /** Rendered link text / inline children. */
  children?: Snippet;
  /** Any remaining anchor attributes forwarded by Comark (e.g. `title`). */
  [key: string]: unknown;
}

let { href = undefined, children, ...rest }: Props = $props();
</script>

<a {href} {...rest} target="_blank" rel="noopener noreferrer"> {@render children?.()} </a>
