<script lang="ts">
import { useNodesInitialized, useSvelteFlow } from "@xyflow/svelte";
import { untrack } from "svelte";

interface Props {
  fitViewTrigger?: number;
  /**
   * Fired once the initial fit-view has completed. Lets the parent reveal the
   * graph only after it has been zoomed/panned to fit, avoiding a visible frame
   * where nodes are rendered at the default (unfitted) viewport.
   */
  onInitialFit?: () => void;
}

let { fitViewTrigger = 0, onInitialFit }: Props = $props();

const { fitView } = useSvelteFlow();
const nodesInitialized = useNodesInitialized();

let hasFitted = $state(false);
let lastTrigger = $state(0);
let pendingFit = $state(false);

$effect(() => {
  if (nodesInitialized.current && !hasFitted) {
    hasFitted = true;
    lastTrigger = fitViewTrigger;
    requestAnimationFrame(() => {
      // Fit without an animation on first paint so the graph appears already
      // at the correct zoom/position, then notify the parent to reveal it.
      fitView({ duration: 0 }).then(() => onInitialFit?.());
    });
  }
});

// External trigger: mark pending fit when trigger changes
$effect(() => {
  if (fitViewTrigger !== lastTrigger) {
    lastTrigger = fitViewTrigger;
    pendingFit = true;
  }
});

// Wait for nodes to be initialized/settled before actually fitting
$effect(() => {
  if (pendingFit && nodesInitialized.current) {
    untrack(() => {
      pendingFit = false;
    });
    // Small delay to ensure layout is complete after node changes
    setTimeout(() => fitView(), 50);
  }
});
</script>
