<script lang="ts">
/**
 * Screen-anchored popup wrapping {@link StepTypePicker}, used when inserting a
 * step on an edge. Clicking outside or pressing Escape dismisses it.
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
</script>

<div
  class="fixed inset-0 z-9999"
  onclick={onclose}
  onkeydown={(e) => {
    if (e.key === "Escape") onclose();
  }}
  role="presentation"
>
  <div
    class="fixed z-9999 min-w-52 max-h-80 overflow-y-auto rounded-xl border border-border bg-background p-1.5 shadow-lg text-sm"
    style="left: {position.x}px; top: {position.y}px; transform: translateX(-50%);"
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
    role="menu"
    tabindex="-1"
  >
    <StepTypePicker {customStepTypes} {onselect} />
  </div>
</div>
