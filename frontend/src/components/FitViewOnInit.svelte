<script lang="ts">
import { useNodesInitialized, useSvelteFlow } from "@xyflow/svelte";
import { untrack } from "svelte";

interface Props {
  fitViewTrigger?: number;
}

let { fitViewTrigger = 0 }: Props = $props();

const { fitView, getNodes } = useSvelteFlow();
const nodesInitialized = useNodesInitialized();

let hasFitted = $state(false);
let lastNodeCount = $state(0);
let lastTrigger = $state(0);
let pendingFit = $state(false);

$effect(() => {
  if (nodesInitialized.current && !hasFitted) {
    hasFitted = true;
    lastNodeCount = getNodes().length;
    lastTrigger = fitViewTrigger;
    requestAnimationFrame(() => fitView());
  }
});

$effect(() => {
  if (!hasFitted) return;
  const currentCount = getNodes().length;
  if (currentCount !== lastNodeCount) {
    lastNodeCount = currentCount;
    pendingFit = true;
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
