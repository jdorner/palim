<script lang="ts">
import { Handle, type NodeProps, Position } from "@xyflow/svelte";
import PlusIcon from "phosphor-svelte/lib/PlusIcon";

let { isConnectable }: NodeProps = $props();
</script>

<div
  class="flex items-center justify-center rounded-full border-2 border-dashed border-blue-500/40 bg-muted/20 cursor-pointer hover:bg-muted/40 hover:border-primary/60 transition-all duration-200"
  style="width: 24px; height: 24px;"
  title="Add Step"
>
  <PlusIcon size={20} class="text-blue-500" />
  <Handle type="target" position={Position.Top} />
</div>
