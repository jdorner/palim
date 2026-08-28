<script lang="ts">
/**
 * Shared step type picker menu content.
 * Renders the list of available step types grouped by category (Steps + Control Flow).
 * Used by both AddStepNode (the dashed circle menu) and the edge insert popup.
 */
import { visualForStepType } from "$lib/nodeVisuals";

interface StepTypeEntry {
  type: string;
  label: string;
  icon?: string;
  category?: string;
}

interface Props {
  /** Custom step types from extensions. */
  customStepTypes: StepTypeEntry[];
  /** Called when a type is selected. */
  onselect: (type: string) => void;
  /** Whether to include control-flow types (iterator, if, case, etc.). Default: true. */
  includeControlFlow?: boolean;
}

let { customStepTypes, onselect, includeControlFlow = true }: Props = $props();

const builtinTypes = [
  { type: "agent", label: "Agent", category: "execution" },
  { type: "iterator", label: "Iterator", category: "control-flow" },
  { type: "if", label: "If / Condition", category: "control-flow" },
  { type: "case", label: "Case / Switch", category: "control-flow" },
  { type: "waitFor", label: "Wait For Signal", category: "control-flow" },
  { type: "emit", label: "Emit Signal", category: "control-flow" },
] as const;

const builtinTypeSlugs = new Set<string>(builtinTypes.map((t) => t.type));

let controlFlowTypes = $derived(builtinTypes.filter((t) => t.category === "control-flow"));
let customTypes = $derived(customStepTypes.filter((t) => !builtinTypeSlugs.has(t.type)));
let customActionTypes = $derived(customTypes.filter((t) => t.category !== "control-flow"));
let customControlFlowTypes = $derived(customTypes.filter((t) => t.category === "control-flow"));
let agentVisual = $derived(visualForStepType("agent"));
</script>

<!-- Steps section -->
<div class="px-2 pt-1 pb-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Steps</div>
<button
  type="button"
  class="w-full text-left px-2 py-1.5 rounded-lg hover:bg-muted/60 transition-colors flex items-center gap-2.5"
  onclick={() => onselect("agent")}
>
  <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white {agentVisual.tileClass}">
    <agentVisual.icon size={15} weight="bold" aria-hidden="true" />
  </span>
  <span class="font-medium text-foreground">Agent</span>
</button>
{#each customActionTypes as ct}
  {@const ctVisual = visualForStepType(ct.type, { iconId: ct.icon, category: ct.category })}
  <button
    type="button"
    class="w-full text-left px-2 py-1.5 rounded-lg hover:bg-muted/60 transition-colors flex items-center gap-2.5"
    onclick={() => onselect(ct.type)}
  >
    <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white {ctVisual.tileClass}">
      <ctVisual.icon size={15} weight="bold" aria-hidden="true" />
    </span>
    <span class="font-medium text-foreground">{ct.label}</span>
  </button>
{/each}

<!-- Control flow section -->
{#if includeControlFlow}
  <div class="border-t border-border my-1"></div>
  <div class="px-2 pt-1 pb-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
    Control Flow
  </div>
  {#each controlFlowTypes as cf}
    {@const cfVisual = visualForStepType(cf.type)}
    <button
      type="button"
      class="w-full text-left px-2 py-1.5 rounded-lg hover:bg-muted/60 transition-colors flex items-center gap-2.5"
      onclick={() => onselect(cf.type)}
    >
      <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white {cfVisual.tileClass}">
        <cfVisual.icon size={15} weight="bold" aria-hidden="true" />
      </span>
      <span class="font-medium text-foreground">{cf.label}</span>
    </button>
  {/each}
  {#each customControlFlowTypes as cf}
    {@const cfVisual = visualForStepType(cf.type, { iconId: cf.icon, category: cf.category })}
    <button
      type="button"
      class="w-full text-left px-2 py-1.5 rounded-lg hover:bg-muted/60 transition-colors flex items-center gap-2.5"
      onclick={() => onselect(cf.type)}
    >
      <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white {cfVisual.tileClass}">
        <cfVisual.icon size={15} weight="bold" aria-hidden="true" />
      </span>
      <span class="font-medium text-foreground">{cf.label}</span>
    </button>
  {/each}
{/if}
