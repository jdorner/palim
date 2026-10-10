<!--
  Colored header bar for the workflow step / trigger detail panel (docked
  sidebar and floating node popup). Shows the step type icon and label as the
  title, the step slug as an optional subtitle, and icon buttons to switch
  between form and JSON view and to close the panel.
-->
<script lang="ts">
import BracketsCurlyIcon from "phosphor-svelte/lib/BracketsCurlyIcon";
import TextboxIcon from "phosphor-svelte/lib/TextboxIcon";
import XIcon from "phosphor-svelte/lib/XIcon";
import { t } from "$lib/i18n.svelte";
import { visualForStepType } from "$lib/nodeVisuals";
import { categoryForType, iconIdForType, labelForStepType } from "$lib/stepTypes";

interface Props {
  /** Step type identifier ("trigger" for the trigger node). */
  type: string;
  /** Trigger subtype (only used when `type` is "trigger"). */
  triggerType?: string;
  /** Optional secondary line (e.g. the step slug). */
  subtitle?: string;
  /** Whether the JSON view is currently shown. */
  jsonView?: boolean;
  /** Toggle between form and JSON view; the toggle button is hidden when omitted. */
  onToggleJson?: () => void;
  /** Close the panel. */
  onclose: () => void;
}

let { type, triggerType, subtitle, jsonView = false, onToggleJson, onclose }: Props = $props();

let visual = $derived(
  type === "trigger"
    ? visualForStepType("trigger", { triggerType })
    : visualForStepType(type, { iconId: iconIdForType(type), category: categoryForType(type) }),
);
let title = $derived(labelForStepType(type, triggerType));
</script>

<div class="relative shrink-0 flex items-center gap-2.5 px-3 py-1.5 text-white {visual.tileClass}">
  <!-- Subtle sheen so the flat category color reads as a header band -->
  <div class="pointer-events-none absolute inset-0 bg-linear-to-r from-black/10 to-white/15" aria-hidden="true"></div>
  <span class="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white/20">
    <visual.icon size={17} weight="bold" aria-hidden="true" />
  </span>
  <div class="relative flex-1 min-w-0 flex flex-col leading-tight">
    <span class="text-sm font-semibold truncate">{title}</span>
    {#if subtitle}
      <span class="text-[11px] text-white/80 font-mono truncate">{subtitle}</span>
    {/if}
  </div>
  <div class="relative flex items-center gap-0.5 shrink-0">
    {#if onToggleJson}
      <button
        type="button"
        class="p-1.5 rounded-md text-white/85 hover:text-white hover:bg-white/20 transition-colors"
        onclick={onToggleJson}
        aria-label={jsonView ? t("stepPanel.showForm") : t("stepPanel.showJson")}
        title={jsonView ? t("stepPanel.formView") : t("stepPanel.jsonView")}
      >
        {#if jsonView}
          <TextboxIcon size={16} weight="bold" aria-hidden="true" />
        {:else}
          <BracketsCurlyIcon size={16} weight="bold" aria-hidden="true" />
        {/if}
      </button>
    {/if}
    <button
      type="button"
      class="p-1.5 rounded-md text-white/85 hover:text-white hover:bg-white/20 transition-colors"
      onclick={onclose}
      aria-label={t("stepPanel.closePanel")}
      title={t("common.close")}
    >
      <XIcon size={16} weight="bold" aria-hidden="true" />
    </button>
  </div>
</div>
