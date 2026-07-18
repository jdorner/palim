<script lang="ts">
/**
 * A compact circular ring gauge.
 * Displays a 16×16 SVG ring that fills clockwise with color-coded pressure
 * and a percentage label. Color thresholds are configurable.
 */

/** A color threshold: applies the given Tailwind stroke class when percentage is below `below`. */
export interface ColorStop {
  /** Upper bound (exclusive) — this color applies when pct < below. */
  below: number;
  /** Tailwind stroke class (e.g. "stroke-green-500"). */
  class: string;
}

interface Props {
  /** Number of input tokens consumed (context size at this turn). */
  usedTokens: number;
  /** Maximum context window size in tokens. */
  maxTokens: number;
  /**
   * Color stops sorted by ascending `below` value.
   * The first stop whose `below` exceeds the current percentage wins.
   * Defaults to green < 50%, amber 50–79%, red ≥ 80%.
   */
  colors?: ColorStop[];
}

const DEFAULT_COLORS: ColorStop[] = [
  { below: 50, class: "stroke-green-500" },
  { below: 80, class: "stroke-amber-500" },
  { below: 101, class: "stroke-red-500" },
];

let { usedTokens, maxTokens, colors = DEFAULT_COLORS }: Props = $props();

const radius = 7;
const circumference = 2 * Math.PI * radius;

let pct = $derived(Math.min(Math.round((usedTokens / maxTokens) * 100), 100));
let offset = $derived(circumference - (pct / 100) * circumference);
let color = $derived(colors.find((s) => pct < s.below)?.class ?? colors[colors.length - 1]?.class ?? "stroke-current");
</script>

<span
  class="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-muted-foreground/70 tabular-nums"
  title="Context usage: {usedTokens.toLocaleString()} of {maxTokens.toLocaleString()}"
>
  <svg width="16" height="16" viewBox="0 0 18 18" class="shrink-0" aria-hidden="true">
    <circle cx="9" cy="9" r={radius} fill="none" class="stroke-muted-foreground/20" stroke-width="2.5" />
    <circle
      cx="9"
      cy="9"
      r={radius}
      fill="none"
      class={color}
      stroke-width="2.5"
      stroke-dasharray={circumference}
      stroke-dashoffset={offset}
      stroke-linecap="round"
      transform="rotate(-90 9 9)"
    />
  </svg>
  {pct}%
</span>
