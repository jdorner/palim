<script lang="ts">
/**
 * A colored dot indicator for job/step status.
 * Gray = waiting/delayed/unknown, amber = waiting-signal, blue (pulsing) = active, green = completed,
 * red = failed (a lighter red in dark mode, where the theme's destructive color is too dark for a small dot).
 */
let {
  status,
  title = "",
  size = "sm",
  still = false,
}: {
  status: string;
  title?: string;
  size?: "sm" | "md";
  /** Suppresses the pulse of "active", e.g. when the dot only labels a count of zero. */
  still?: boolean;
} = $props();

const sizeClass = $derived(size === "md" ? "w-2.5 h-2.5" : "w-2 h-2");
</script>

<span
  class="{sizeClass} rounded-full shrink-0 inline-block"
  class:bg-muted-foreground={status !== "active" &&
    status !== "completed" &&
    status !== "failed" &&
    status !== "waiting-signal"}
  class:bg-blue-500={status === "active"}
  class:animate-pulse={status === "active" && !still}
  class:bg-amber-400={status === "waiting-signal"}
  class:bg-green-500={status === "completed"}
  class:bg-destructive={status === "failed"}
  class:dark:bg-red-500={status === "failed"}
  title={title || undefined}
></span>
