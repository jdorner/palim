<script lang="ts">
interface Props {
  id?: string;
  /** Whether the toggle is in the on state. */
  checked: boolean;
  /** Callback invoked when the toggle is clicked. Receives the new boolean state. */
  onChange?: (checked: boolean) => void;
  /** Optional disabled state for the toggle button. */
  disabled?: boolean;
  "aria-label"?: string;
}

let props: Props = $props();
</script>

<button
  type="button"
  role="switch"
  aria-checked={props.checked ? "true" : "false"}
  aria-label={props["aria-label"]}
  disabled={props.disabled}
  class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors disabled:cursor-not-allowed disabled:opacity-50
    {props.checked ? 'bg-green-600' : 'bg-muted-foreground/30'}"
  onclick={() => props.onChange?.(!props.checked)}
>
  <span
    class="pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-sm transition-transform
      {props.checked ? 'translate-x-4' : 'translate-x-0'}"
  ></span>
</button>
