<script lang="ts">
/**
 * Screen-anchored popup wrapping {@link StepTypePicker}, used when inserting a
 * step on an edge. Clicking outside or pressing Escape (handled by the picker)
 * dismisses it.
 */
import type { StepTypeInfo } from "$shared/extensions";
import StepTypePicker from "./StepTypePicker.svelte";

interface Props {
  /** Viewport coordinates of the popup's top-center anchor. */
  position: { x: number; y: number };
  /** Custom step types from extensions. */
  customStepTypes: StepTypeInfo[];
  /** Called with the chosen step type. */
  onselect: (type: string) => void;
  /** Called when the popup is dismissed without a choice. */
  onclose: () => void;
}

let { position, customStepTypes, onselect, onclose }: Props = $props();

const MARGIN = 8;

let menuEl = $state<HTMLDivElement | null>(null);
/** Top-left corner of the popup, kept inside the viewport once it is measured. */
let placement = $state<{ left: number; top: number } | null>(null);

$effect(() => {
  const { x, y } = position;
  if (!menuEl) return;
  const width = menuEl.offsetWidth;
  const height = menuEl.offsetHeight;
  const left = Math.min(Math.max(x - width / 2, MARGIN), window.innerWidth - width - MARGIN);
  const top = y + height > window.innerHeight - MARGIN ? Math.max(MARGIN, window.innerHeight - height - MARGIN) : y;
  placement = { left, top };
});
</script>

<div class="fixed inset-0 z-9999" onclick={onclose} role="presentation">
  <div
    class="fixed z-9999 rounded-xl border border-border bg-background p-1.5 shadow-lg text-sm"
    bind:this={menuEl}
    style={placement
      ? `left: ${placement.left}px; top: ${placement.top}px;`
      : `left: ${position.x}px; top: ${position.y}px; transform: translateX(-50%);`}
    onclick={(e) => e.stopPropagation()}
    role="presentation"
  >
    <StepTypePicker {customStepTypes} {onselect} {onclose} />
  </div>
</div>
