<!--
  Large editor dialog for a textarea (agent prompt, multi-line step fields,
  JSON views). Edits apply live through `oninput`, like the inline textarea;
  "Done" only closes the dialog. The dialog keeps its own copy of the text,
  taken when it opens, so a caller that normalizes the value (e.g. re-formats
  JSON) does not rewrite the text under the cursor. Template autocomplete is attached when a
  template context is given.

  The dialog is portaled to document.body so the fixed overlay escapes the
  floating step panel (which can sit inside the graph's transformed viewport).
  Escape is marked as handled so the page does not also close the panel or
  leave edit mode.
-->
<script lang="ts">
import { untrack } from "svelte";
import { Button } from "$lib/components/ui/button";
import { Dialog } from "$lib/components/ui/dialog";
import { t } from "$lib/i18n.svelte";
import type { OutputSchemas, SlugEdge } from "$lib/templateScope";
import { variablePicker } from "$lib/variablePicker.svelte";
import TemplateAutocomplete from "./TemplateAutocomplete.svelte";

/** Context for template autocomplete in the dialog. */
export interface ExpandedTemplateContext {
  steps: Array<{ slug: string; [key: string]: unknown }>;
  currentStepIndex: number;
  secretKeys: string[];
  variableKeys?: string[];
  outputSchemas?: OutputSchemas;
  edges?: SlugEdge[];
  /** Dotted path of the edited field within the step config. */
  fieldPath?: string;
}

interface Props {
  /** Dialog title (the field label). */
  title: string;
  /** Muted text below the title (e.g. the step slug). */
  description?: string;
  /** Text when the dialog opens. */
  value: string;
  /** Called on every edit with the new text. */
  oninput: (value: string) => void;
  /** Called when the dialog is dismissed or "Done" is clicked. */
  onClose: () => void;
  /** Maximum length; also shown as a counter in the footer. */
  maxlength?: number;
  placeholder?: string;
  /** Template autocomplete context; omit to disable autocomplete. */
  template?: ExpandedTemplateContext;
  /** When true, the text cannot be edited. */
  readonly?: boolean;
}

let { title, description, value, oninput, onClose, maxlength, placeholder, template, readonly }: Props = $props();

let textareaEl = $state<HTMLTextAreaElement | null>(null);

/**
 * With the variable picker switched on, the dialog is shifted right on wider
 * screens so the picker (docked to its left) does not cover the text.
 */
let dialogClass = $derived(template && !readonly && variablePicker.open ? "max-w-4xl sm:ml-[296px]" : "max-w-4xl");

/** The edited text (initialized once from `value`). */
let text = $state(untrack(() => value));

/** Applies an edit locally and passes it on. */
function edit(next: string) {
  text = next;
  oninput(next);
}

/** Svelte action that portals the element to document.body. */
function portal(node: HTMLElement) {
  document.body.appendChild(node);
  return {
    destroy() {
      node.remove();
    },
  };
}
</script>

<div
  use:portal
  role="presentation"
  onkeydown={(e) => {
    if (e.key === "Escape") e.preventDefault();
  }}
>
  <Dialog open {title} {description} class={dialogClass} {onClose}>
    <!-- Single child of the dialog body: its space-y spacing would otherwise
         add a margin under the textarea while the autocomplete popup is open. -->
    <div>
      <textarea
        bind:this={textareaEl}
        aria-label={title}
        class="block w-full h-[60vh] px-3 py-2 text-sm font-mono border border-border rounded-md bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring"
        {maxlength}
        {placeholder}
        {readonly}
        spellcheck="false"
        value={text}
        oninput={(e) => edit(e.currentTarget.value)}
      ></textarea>
      {#if template && !readonly}
        <TemplateAutocomplete targetElement={textareaEl} {...template} onChange={edit} />
      {/if}
    </div>
    {#snippet footer()}
      {#if maxlength !== undefined}
        <span class="mr-auto self-center text-xs text-muted-foreground">{text.length}/ {maxlength}</span>
      {/if}
      <Button size="sm" onclick={onClose}>{t("stepSidebar.done")}</Button>
    {/snippet}
  </Dialog>
</div>
