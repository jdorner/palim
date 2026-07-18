<script lang="ts" module>
import { tv, type VariantProps } from "tailwind-variants";

export const badgeVariants = tv({
  base: "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  variants: {
    variant: {
      default: "border-transparent bg-primary text-primary-foreground hover:bg-primary/80",
      secondary: "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
      destructive: "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80",
      success: "border-transparent bg-green-700 text-white hover:bg-green-800",
      warning: "border-transparent bg-yellow-500 text-white hover:bg-yellow-600",
      outline: "text-foreground",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export type BadgeVariant = VariantProps<typeof badgeVariants>["variant"];
</script>

<script lang="ts">
import type { Snippet } from "svelte";
import { cn } from "$lib/utils";

interface Props extends Record<string, any> {
  class?: string;
  variant?: BadgeVariant;
  children?: Snippet;
}

let { class: className, variant = "default", children, ...restProps }: Props = $props();
</script>

<div class={cn(badgeVariants({ variant }), className)} {...restProps}>{@render children?.()}</div>
