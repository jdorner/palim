<script lang="ts">
import { Handle, type NodeProps, Position } from "@xyflow/svelte";
import PlusIcon from "phosphor-svelte/lib/PlusIcon";
import { tick } from "svelte";
import { visualForStepType } from "$lib/nodeVisuals";

interface Props extends NodeProps {
  data: {
    /** Callback when a step type is selected from the menu. */
    onSelectType?: (type: string) => void;
    /** Custom step types from extensions (passed from parent). */
    customStepTypes?: Array<{ type: string; label: string; icon?: string; category?: string }>;
  };
}

let { data, isConnectable }: Props = $props();

let menuOpen = $state(false);
let buttonRef = $state<HTMLButtonElement | null>(null);
let menuRef = $state<HTMLDivElement | null>(null);
let menuPos = $state({ x: 0, y: 0 });

async function toggleMenu(e: MouseEvent) {
  e.stopPropagation();
  if (!menuOpen && buttonRef) {
    const rect = buttonRef.getBoundingClientRect();
    menuPos = { x: rect.left + rect.width / 2, y: rect.bottom + 4 };
  }
  menuOpen = !menuOpen;

  if (menuOpen) {
    // After render, adjust if the menu overflows the viewport
    await tick();
    adjustMenuPosition();
  }
}

function adjustMenuPosition() {
  if (!menuRef) return;
  const rect = menuRef.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let { x, y } = menuPos;

  // Horizontal: keep within viewport
  const halfW = rect.width / 2;
  if (x - halfW < 8) x = halfW + 8;
  if (x + halfW > vw - 8) x = vw - halfW - 8;

  // Vertical: flip above if overflowing bottom
  if (y + rect.height > vh - 8) {
    const buttonRect = buttonRef?.getBoundingClientRect();
    y = (buttonRect?.top ?? y) - rect.height - 4;
  }

  menuPos = { x, y };
}

function selectType(type: string) {
  menuOpen = false;
  data.onSelectType?.(type);
}

function handleClickOutside(e: MouseEvent) {
  if (!menuOpen) return;
  const target = e.target as HTMLElement;
  if (buttonRef?.contains(target)) return;
  if (menuRef?.contains(target)) return;
  menuOpen = false;
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

/**
 * Built-in step types available in the menu. Icons/colors are resolved from the
 * shared nodeVisuals helper so the menu rows match the rendered node cards.
 */
const builtinTypes = [
  { type: "agent", label: "Agent", category: "execution" },
  { type: "if", label: "If / Condition", category: "control-flow" },
  { type: "case", label: "Case / Switch", category: "control-flow" },
  { type: "waitFor", label: "Wait For Signal", category: "control-flow" },
  { type: "emit", label: "Emit Signal", category: "control-flow" },
] as const;

/** Slugs handled by the built-in menu entries above, used to de-duplicate. */
const builtinTypeSlugs = new Set<string>(builtinTypes.map((t) => t.type));

let controlFlowTypes = $derived(builtinTypes.filter((t) => t.category === "control-flow"));
// Exclude custom step types that duplicate a built-in type (e.g. the workflows
// extension registers "emit", which is already listed under Control Flow).
let customTypes = $derived((data.customStepTypes ?? []).filter((t) => !builtinTypeSlugs.has(t.type)));
// Custom step types that opt into the control-flow palette group (e.g. for-each)
// render under the "Control Flow" section; the rest stay in the default group.
let customActionTypes = $derived(customTypes.filter((t) => t.category !== "control-flow"));
let customControlFlowTypes = $derived(customTypes.filter((t) => t.category === "control-flow"));
let agentVisual = $derived(visualForStepType("agent"));
</script>

<svelte:document onclick={handleClickOutside} />

<div class="relative" style="width: 32px; height: 32px;">
  <button
    type="button"
    bind:this={buttonRef}
    class="flex items-center justify-center rounded-full border-2 border-dashed border-primary/40 bg-muted/20 cursor-pointer hover:bg-muted/50 hover:border-primary/70 transition-all duration-200"
    style="width: 32px; height: 32px;"
    title="Add Step"
    onclick={toggleMenu}
  >
    <PlusIcon size={20} weight="bold" class="text-primary" />
  </button>
  <Handle type="target" position={Position.Left} />
</div>

{#if menuOpen}
  <div
    use:portal
    bind:this={menuRef}
    class="fixed z-9999 min-w-52 max-h-80 overflow-y-auto rounded-xl border border-border bg-background p-1.5 shadow-lg text-sm"
    style="left: {menuPos.x}px; top: {menuPos.y}px; transform: translateX(-50%);"
  >
    <!-- Execution steps -->
    <div class="px-2 pt-1 pb-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Steps</div>
    <button
      type="button"
      class="w-full text-left px-2 py-1.5 rounded-lg hover:bg-muted/60 transition-colors flex items-center gap-2.5"
      onclick={() => selectType("agent")}
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
        onclick={() => selectType(ct.type)}
      >
        <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white {ctVisual.tileClass}">
          <ctVisual.icon size={15} weight="bold" aria-hidden="true" />
        </span>
        <span class="font-medium text-foreground">{ct.label}</span>
      </button>
    {/each}

    <!-- Control flow -->
    <div class="border-t border-border my-1"></div>
    <div class="px-2 pt-1 pb-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
      Control Flow
    </div>
    {#each controlFlowTypes as cf}
      {@const cfVisual = visualForStepType(cf.type)}
      <button
        type="button"
        class="w-full text-left px-2 py-1.5 rounded-lg hover:bg-muted/60 transition-colors flex items-center gap-2.5"
        onclick={() => selectType(cf.type)}
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
        onclick={() => selectType(cf.type)}
      >
        <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white {cfVisual.tileClass}">
          <cfVisual.icon size={15} weight="bold" aria-hidden="true" />
        </span>
        <span class="font-medium text-foreground">{cf.label}</span>
      </button>
    {/each}
  </div>
{/if}
