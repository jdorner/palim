<script lang="ts">
/**
 * A colored dot indicator for job/step status.
 * Gray = waiting/delayed/unknown, blue (pulsing) = active, green = completed, red = failed.
 */
let {
  status,
  title = "",
  size = "sm",
}: {
  status: string;
  title?: string;
  size?: "sm" | "md";
} = $props();

const sizeClass = $derived(size === "md" ? "w-2.5 h-2.5" : "w-2 h-2");
</script>

<span
  class="{sizeClass} rounded-full shrink-0 inline-block"
  class:bg-muted-foreground={status !== "active" && status !== "completed" && status !== "failed"}
  class:bg-blue-500={status === "active"}
  class:animate-pulse={status === "active"}
  class:bg-green-500={status === "completed"}
  class:bg-destructive={status === "failed"}
  {title}
></span>
