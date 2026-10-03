<script lang="ts">
import { useNodesInitialized, useSvelteFlow } from "@xyflow/svelte";

interface Props {
  /**
   * Fired once the initial fit-view has completed. Lets the parent reveal the
   * graph only after it has been zoomed/panned to fit, avoiding a visible frame
   * where nodes are rendered at the default (unfitted) viewport.
   */
  onInitialFit?: () => void;
}

let { onInitialFit }: Props = $props();

const { fitView } = useSvelteFlow();
const nodesInitialized = useNodesInitialized();

let hasFitted = $state(false);

$effect(() => {
  if (nodesInitialized.current && !hasFitted) {
    hasFitted = true;
    requestAnimationFrame(() => {
      // Fit without an animation on first paint so the graph appears already
      // at the correct zoom/position, then notify the parent to reveal it.
      fitView({ duration: 0 }).then(() => onInitialFit?.());
    });
  }
});
</script>
