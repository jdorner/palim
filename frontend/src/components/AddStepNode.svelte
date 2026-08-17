<script lang="ts">
import { Handle, type NodeProps, Position } from "@xyflow/svelte";
import PlusIcon from "phosphor-svelte/lib/PlusIcon";
import { tick } from "svelte";

interface Props extends NodeProps {
  data: {
    /** Callback when a step type is selected from the menu. */
    onSelectType?: (type: string) => void;
    /** Custom step types from extensions (passed from parent). */
    customStepTypes?: Array<{ type: string; label: string; icon?: string }>;
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

/** Built-in step types available in the menu. */
const builtinTypes = [
  { type: "agent", label: "Agent", icon: "\uD83E\uDD16", category: "execution" },
  { type: "if", label: "If / Condition", icon: "\u2194\uFE0F", category: "control-flow" },
  { type: "case", label: "Case / Switch", icon: "\uD83D\uDD00", category: "control-flow" },
  { type: "waitFor", label: "Wait For Signal", icon: "\u23F8\uFE0F", category: "control-flow" },
  { type: "emit", label: "Emit Signal", icon: "\uD83D\uDCE1", category: "control-flow" },
] as const;

let customTypes = $derived(data.customStepTypes ?? []);
</script>

<svelte:document onclick={handleClickOutside} />

<div class="relative">
  <button
    type="button"
    bind:this={buttonRef}
    class="flex items-center justify-center rounded-full border-2 border-dashed border-blue-500/40 bg-muted/20 cursor-pointer hover:bg-muted/40 hover:border-primary/60 transition-all duration-200"
    style="width: 32px; height: 32px;"
    title="Add Step"
    onclick={toggleMenu}
  >
    <PlusIcon size={20} class="text-blue-500" />
  </button>
  <Handle type="target" position={Position.Left} />
</div>

{#if menuOpen}
  <div
    use:portal
    bind:this={menuRef}
    class="fixed z-[9999] min-w-[180px] max-h-[320px] overflow-y-auto rounded-lg border border-border bg-background shadow-lg py-1 text-sm"
    style="left: {menuPos.x}px; top: {menuPos.y}px; transform: translateX(-50%);"
  >
    <!-- Execution steps -->
    <div class="px-2 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Steps</div>
    <button
      type="button"
      class="w-full text-left px-3 py-1.5 hover:bg-muted/60 transition-colors flex items-center gap-2"
      onclick={() => selectType("agent")}
    >
      <span>{builtinTypes[0].icon}</span>
      <span>Agent</span>
    </button>
    {#each customTypes as ct}
      <button
        type="button"
        class="w-full text-left px-3 py-1.5 hover:bg-muted/60 transition-colors flex items-center gap-2"
        onclick={() => selectType(ct.type)}
      >
        <span>{ct.icon ?? "\u2699\uFE0F"}</span>
        <span>{ct.label}</span>
      </button>
    {/each}

    <!-- Control flow -->
    <div class="border-t border-border my-1"></div>
    <div class="px-2 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Control Flow</div>
    {#each builtinTypes.filter(t => t.category === "control-flow") as cf}
      <button
        type="button"
        class="w-full text-left px-3 py-1.5 hover:bg-muted/60 transition-colors flex items-center gap-2"
        onclick={() => selectType(cf.type)}
      >
        <span>{cf.icon}</span>
        <span>{cf.label}</span>
      </button>
    {/each}
  </div>
{/if}
