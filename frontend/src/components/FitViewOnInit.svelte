<script lang="ts">
import { useNodesInitialized, useSvelteFlow } from "@xyflow/svelte";

const { fitView, getNodes } = useSvelteFlow();
const nodesInitialized = useNodesInitialized();

let hasFitted = $state(false);
let lastNodeCount = $state(0);

$effect(() => {
  if (nodesInitialized.current && !hasFitted) {
    hasFitted = true;
    lastNodeCount = getNodes().length;
    requestAnimationFrame(() => fitView());
  }
});

$effect(() => {
  if (!hasFitted) return;
  const currentCount = getNodes().length;
  if (currentCount !== lastNodeCount) {
    lastNodeCount = currentCount;
    requestAnimationFrame(() => fitView());
  }
});
</script>
