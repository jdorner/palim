<script lang="ts">
import { Handle, type NodeProps, Position } from "@xyflow/svelte";
import PlusIcon from "phosphor-svelte/lib/PlusIcon";
import { tick } from "svelte";
import StepTypePicker from "./StepTypePicker.svelte";

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

  const halfW = rect.width / 2;
  if (x - halfW < 8) x = halfW + 8;
  if (x + halfW > vw - 8) x = vw - halfW - 8;

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
    <StepTypePicker customStepTypes={data.customStepTypes ?? []} onselect={selectType} />
  </div>
{/if}
