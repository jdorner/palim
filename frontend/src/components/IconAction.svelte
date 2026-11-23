<script lang="ts">
import type { IconComponentProps } from "phosphor-svelte";
import type { Component } from "svelte";
import { Button } from "$lib/components/ui/button";

/**
 * Icon-only row action for dense lists (edit, duplicate, logs, delete): a ghost
 * button with the label as tooltip and accessible name, so a row of actions stays
 * calm. `destructive` tints it muted red (full red on hover).
 */
interface Props {
  /** Tooltip and accessible name. */
  label: string;
  /** Phosphor icon component to show. */
  icon: Component<IconComponentProps>;
  /** Click handler; the click does not bubble to the row. */
  onclick: () => void;
  /** Disables the button. */
  disabled?: boolean;
  /** Muted grey (default) or muted red. */
  tone?: "muted" | "destructive";
  /** `sm` (36px, default) for tables and cards, `xs` (24px) for compact lists. */
  size?: "xs" | "sm";
  /** Extra classes for the icon, e.g. `animate-spin` while busy. */
  iconClass?: string;
}

let { label, icon: Icon, onclick, disabled = false, tone = "muted", size = "sm", iconClass = "" }: Props = $props();

const toneClass = $derived(
  tone === "destructive"
    ? "text-destructive/60 hover:bg-destructive/10 hover:text-destructive dark:text-red-400/80 dark:hover:bg-red-400/10 dark:hover:text-red-400"
    : "text-muted-foreground",
);
</script>

<Button
  size="icon"
  variant="ghost"
  class="{size === "xs" ? "size-6" : "size-9"} shrink-0 {toneClass}"
  {disabled}
  title={label}
  aria-label={label}
  onclick={(e: Event) => {
    e.stopPropagation();
    onclick();
  }}
>
  <Icon size={size === "xs" ? 14 : 16} class={iconClass} aria-hidden="true" />
</Button>
